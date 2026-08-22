from pathlib import Path

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

replacements = [
    ('  ACTIVE_RUNTIME_AGENT_TOOLS,\n', '', 'active tool import'),
    ('import { executeBookingSelectSlotBatch } from "./bookingSelectSlot.ts";\n', '', 'direct select import'),
    ('import { resolveBookingSelectApplyBatchConflict } from "./bookingSelectApplyBatchConflict.ts";\n', '', 'direct conflict import'),
    ('import { executeRuntimeToolBatchKernel } from "./runtimeToolBatchKernel.ts";\n', 'import { executeRuntimeToolBatchKernel, completeRuntimeToolBatchWithBookingResult } from "./runtimeToolBatchKernel.ts";\n', 'kernel import'),
    ('const ACTIVE_TOOL_SET = new Set<string>(ACTIVE_RUNTIME_AGENT_TOOLS);\n\n', '', 'active tool set'),
]
for old, new, label in replacements:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    source = source.replace(old, new, 1)

start_marker = '''      // Global preflight A — past-time guard: if booking.apply is requested for a\n'''
end_marker = '''      }  // end if (!guardSFired) normal tool loop\n'''
if source.count(start_marker) != 1:
    raise SystemExit(f"first-batch start marker count={source.count(start_marker)}")
if source.count(end_marker) != 1:
    raise SystemExit(f"first-batch end marker count={source.count(end_marker)}")
start = source.index(start_marker)
end = source.index(end_marker, start) + len(end_marker)

new_block = r'''      const bookingApplyRound1 = toolRequests.find((r) => r.tool === "booking.apply") ?? null;

      // Prepare/freeze identity before the shared batch kernel. The kernel itself owns
      // no booking write and no patient resolution; it receives the effective people view
      // only so slot proof can bind to the same deterministic subject registry.
      const round1BookingPreparation = bookingApplyRound1
        ? prepareBookingApplyExecution({
            booking_apply: bookingApplyRound1,
            booking_subjects: input.booking_subjects ?? null,
            channel_contact: input.channel_contact ?? null,
            current_turn_typed_phone: input.current_turn_typed_phone ?? null,
          })
        : null;
      let effectiveBookingSubjects: BookingSubjectsState | null =
        round1BookingPreparation?.effective_booking_subjects ?? input.booking_subjects ?? null;
      let effectiveInput: RuntimeAgentTurnInput = effectiveBookingSubjects !== (input.booking_subjects ?? null)
        ? { ...input, booking_subjects: effectiveBookingSubjects }
        : input;
      let bootstrappedRegistry: BookingSubjectsState | null =
        round1BookingPreparation?.bootstrapped_registry ?? null;

      // Both model tool phases now share one deterministic non-write/state kernel.
      // The first-batch availability past-time guard above intentionally remains outside:
      // it distinguishes "requested time already passed" from an authoritative zero-slot result.
      const round1Batch = await executeRuntimeToolBatchKernel({
        requests: toolRequests,
        input: effectiveInput,
        executors: deps.executors,
        prior_booking_process_state: bookingProcessState,
        subjects: effectiveBookingSubjects?.subjects ?? null,
        channel_contact: input.channel_contact ?? null,
        now: turnNow,
      });
      if (round1Batch.availability_diagnostic !== undefined) {
        debug.availability_diagnostic = round1Batch.availability_diagnostic;
      }

      bookingProcessState = round1Batch.booking_process_state;
      if (deps.bookingProcessStateRepository) {
        deps.bookingProcessStateRepository.saveState(
          { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
          bookingProcessState,
          (info) => { if (!info.saved) debug.booking_process_state_save = info; },
        ).catch(() => undefined);
      }

      let guardSFired = round1Batch.select_apply_conflict !== null;
      if (guardSFired) {
        // Historical diagnostic retained while numbered model-call naming still exists.
        debug.reason = "booking_apply_preflight_select_slot_same_round";
      }

      const round1ExecutionSubjectId: SubjectId | null =
        round1BookingPreparation?.ok ? round1BookingPreparation.execution_subject_id : null;
      let round1BookingApplyResolution: BookingApplyResolution | null = null;
      let round1GuardedData: GuardedBookingApplyData | null = null;
      let round1BookingResult: RuntimeAgentToolResult | null = null;

      if (!guardSFired && bookingApplyRound1 && round1BookingPreparation && !round1BookingPreparation.ok) {
        debug.reason = round1BookingPreparation.stage === "subject_validation"
          ? "booking_apply_preflight_subject_id_invalid_round1"
          : "booking_apply_preflight_subject_resolution_conflict_round1";
        round1GuardedData = {
          booking_status: "subject_resolution_conflict",
          created_visit: false,
          may_claim_booked: false,
          required_next_action: "clarify_subject",
          reason: round1BookingPreparation.reason,
        };
      } else if (!guardSFired && bookingApplyRound1) {
        // Read/availability/select state is already authoritative for this batch. This closes
        // the old stale-proof window where booking preflight ran before availability.check.
        const completedBeforeBooking = round1Batch.tool_results;
        if (shouldInterceptNoSlotsBeforeBookingApply({
          pendingToolRequests: toolRequests,
          completedToolResults: completedBeforeBooking,
        })) {
          debug.reason = "booking_apply_preflight_no_slots";
          round1GuardedData = {
            booking_status: "no_available_slots",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_alternative_time",
            reason: "availability_check_returned_no_slots",
          };
        } else {
          const round1Preflight = evaluateBookingApplyPreflight({
            round: 1,
            pendingBookingApply: bookingApplyRound1,
            pendingToolRequests: toolRequests,
            pendingTypedPhone: Boolean(effectiveBookingSubjects?.pending_typed_phone),
            hasBookingPhone: hasSubjectOrContactPhone(effectiveInput, round1ExecutionSubjectId),
            activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,
            selectedSlot: bookingProcessState.selected_slot,
            selectedSlotProof: bookingProcessState.selected_slot_proof,
            timezone,
            now: turnNow,
          });

          if (round1Preflight.outcome === "block") {
            debug.reason = round1Preflight.debug_reason;
            if (round1Preflight.past_time_detail) debug.past_time_detail = round1Preflight.past_time_detail;
            if (round1Preflight.missing_fields) debug.missing_fields = round1Preflight.missing_fields;
            round1GuardedData = round1Preflight.guarded_data;
          } else {
            const bookingExecution = await executeRuntimeToolRequest({
              input: effectiveInput,
              request: bookingApplyRound1,
              executors: deps.executors,
              now: turnNow,
              execution_subject_id: round1ExecutionSubjectId,
            });
            round1BookingResult = bookingExecution.tool_result;
            if (round1ExecutionSubjectId) {
              round1BookingApplyResolution = {
                call_id: bookingApplyRound1.call_id,
                subject_id: round1ExecutionSubjectId,
              };
            }
          }
        }
      }

      if (round1GuardedData && bookingApplyRound1) {
        round1BookingResult = {
          tool: "booking.apply",
          call_id: bookingApplyRound1.call_id,
          status: "success",
          data: round1GuardedData,
        };
      }

      if (round1Batch.select_apply_conflict) {
        // Conflict helper already owns every call id in the batch.
        toolResults.push(...round1Batch.tool_results);
      } else if (bookingApplyRound1 && round1BookingResult) {
        toolResults.push(...completeRuntimeToolBatchWithBookingResult({
          requests: toolRequests,
          partial_results: round1Batch.tool_results,
          booking_result: round1BookingResult,
        }));
      } else {
        toolResults.push(...round1Batch.tool_results);
      }
'''
source = source[:start] + new_block + source[end:]

# R3r terminal UI must also honor a phone guard emitted by the first batch.
old_bounded_ui = '''        if (guardedData?.required_next_action === "ask_for_phone") {\n          const captureUi = buildPhoneCaptureUi(channel);\n          if (captureUi) {\n            finalUi = {\n              ...finalUi,\n              ...captureUi,\n              telegram: { ...(finalUi?.telegram ?? {}), ...(captureUi.telegram ?? {}) },\n            };\n          }\n        }'''
new_bounded_ui = '''        finalUi = forcePhoneCaptureUiForGuard(guardedData ?? round1GuardedData, finalUi, channel);'''
if source.count(old_bounded_ui) != 1:
    raise SystemExit(f"bounded phone UI block count={source.count(old_bounded_ui)}")
source = source.replace(old_bounded_ui, new_bounded_ui, 1)

# Normal second final_response must force contact UI when the first batch was phone-guarded.
old_second_final = '''      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n      return {\n        final_patient_reply: secondOutput.final_response.final_patient_reply,\n        conversation_id: conversationId,\n        tool_requests: toolRequests,\n        tool_results: toolResults,\n        debug,\n        ui: maybeAttachPhoneRequestUI(secondCallVisibleState, secondOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),'''
new_second_final = '''      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n      const secondFinalChannel = typeof input.business_context?.channel === "string"\n        ? input.business_context.channel\n        : undefined;\n      let secondFinalUi = maybeAttachPhoneRequestUI(\n        secondCallVisibleState,\n        secondOutput.final_response.ui,\n        secondFinalChannel,\n      );\n      secondFinalUi = forcePhoneCaptureUiForGuard(round1GuardedData, secondFinalUi, secondFinalChannel);\n      return {\n        final_patient_reply: secondOutput.final_response.final_patient_reply,\n        conversation_id: conversationId,\n        tool_requests: toolRequests,\n        tool_results: toolResults,\n        debug,\n        ui: secondFinalUi,'''
if source.count(old_second_final) != 1:
    raise SystemExit(f"normal second final block count={source.count(old_second_final)}")
source = source.replace(old_second_final, new_second_final, 1)

helper_marker = '''export function maybeAttachPhoneRequestUI(\n'''
if source.count(helper_marker) != 1:
    raise SystemExit(f"maybeAttach marker count={source.count(helper_marker)}")
phone_helper = r'''function forcePhoneCaptureUiForGuard(
  guardedData: GuardedBookingApplyData | null,
  existingUi: AgentUiActions | undefined,
  channel?: string | null,
): AgentUiActions | undefined {
  if (guardedData?.required_next_action !== "ask_for_phone") return existingUi;
  const captureUi = buildPhoneCaptureUi(channel);
  if (!captureUi) return existingUi;
  return {
    ...existingUi,
    ...captureUi,
    telegram: { ...(existingUi?.telegram ?? {}), ...(captureUi.telegram ?? {}) },
  };
}

'''
source = source.replace(helper_marker, phone_helper + helper_marker, 1)

path.write_text(source)
print("R3s guarded first-batch kernel patch applied")

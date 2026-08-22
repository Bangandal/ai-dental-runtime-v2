from pathlib import Path

LOOP = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = LOOP.read_text()

old_import = 'import { executeRuntimeNonWriteToolBatch } from "./runtimeNonWriteToolBatch.ts";\n'
new_import = 'import { executeRuntimeToolBatchKernel } from "./runtimeToolBatchKernel.ts";\n'
if source.count(old_import) != 1:
    raise SystemExit(f"expected one runtimeNonWriteToolBatch import, found {source.count(old_import)}")
source = source.replace(old_import, new_import, 1)

start_marker = '      if (secondOutput.type === "tool_requests") {\n'
end_marker = '      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n'
start = source.find(start_marker)
if start < 0:
    raise SystemExit("second-output tool branch start marker not found")
end = source.find(end_marker, start)
if end < 0:
    raise SystemExit("second-output tool branch end marker not found")

new_branch = r'''      if (secondOutput.type === "tool_requests") {
        // Debug: append current batch tool args using the same PII-safe projection as batch 1.
        if (Array.isArray(debug.tool_call_args)) {
          const round2Args = secondOutput.tool_requests.map((r) => {
            const args = r.arguments ?? {};
            if (r.tool === "availability.check") {
              return {
                tool: r.tool,
                requested_date: args.requested_date ?? null,
                requested_time: args.requested_time ?? null,
                service_interest: args.service_interest ?? null,
              };
            }
            if (r.tool === "booking.apply") {
              return {
                tool: r.tool,
                requested_date: args.requested_date ?? null,
                requested_time: args.requested_time ?? null,
                service: args.service ?? null,
              };
            }
            return { tool: r.tool };
          });
          debug.tool_call_args = [...(debug.tool_call_args as unknown[]), ...round2Args];
        }

        const round2Requests = secondOutput.tool_requests;
        processedToolRequests.push(...round2Requests);

        const allRound2BookingRequests = round2Requests.filter((r) => r.tool === "booking.apply");
        const pendingBookingApply = allRound2BookingRequests[0] ?? null;

        // Stronger invariant: more than one booking write request aborts this whole batch.
        // The existing helper is protocol-complete: every current call id receives a result.
        if (allRound2BookingRequests.length > 1) {
          debug.reason = "booking_apply_preflight_multiple_booking_apply_round2_multi";
          return await finalizeBlockedMultipleBookingApplies({
            pendingRequestsForRound: round2Requests,
            guardedData: {
              booking_status: "subject_resolution_conflict",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "clarify_subject",
              reason: "multiple_booking_apply_requests",
            },
            previousToolResults: toolResults,
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            booking_apply_resolution: round1BookingApplyResolution,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }

        // One external booking write per patient turn. This guard remains stronger than
        // ordinary batch execution. Close the entire current batch, rather than only the
        // booking call, so no sibling function_call is left dangling in OpenAI.
        if (!guardSFired && pendingBookingApply && toolResults.some((r) => r.tool === "booking.apply")) {
          debug.reason = "booking_apply_preflight_multiple_booking_apply_round2";
          return await finalizeBlockedMultipleBookingApplies({
            pendingRequestsForRound: round2Requests,
            guardedData: {
              booking_status: "subject_resolution_conflict",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "clarify_subject",
              reason: "multiple_booking_apply_requests",
            },
            previousToolResults: toolResults,
            toolRequests: processedToolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
            booking_apply_resolution: round1BookingApplyResolution,
            booking_subjects_after_resolution: bootstrappedRegistry,
          });
        }

        // Prepare/freeze the booking target before the batch kernel so a missing registry
        // can still be bootstrapped for subject_2+ and selection can bind to the same people
        // view. A same-batch select+apply dependency conflict still has priority over a
        // preparation failure, preserving the R3p protocol invariant.
        const round2BookingPreparation = pendingBookingApply
          ? prepareBookingApplyExecution({
              booking_apply: pendingBookingApply,
              booking_subjects: effectiveBookingSubjects,
              channel_contact: input.channel_contact ?? null,
              current_turn_typed_phone: input.current_turn_typed_phone ?? null,
            })
          : null;

        if (round2BookingPreparation) {
          effectiveBookingSubjects = round2BookingPreparation.effective_booking_subjects;
          effectiveInput = effectiveBookingSubjects !== (input.booking_subjects ?? null)
            ? { ...input, booking_subjects: effectiveBookingSubjects }
            : input;
          if (round2BookingPreparation.bootstrapped_registry) {
            bootstrappedRegistry = round2BookingPreparation.bootstrapped_registry;
          }
        }

        const round2Batch = await executeRuntimeToolBatchKernel({
          requests: round2Requests,
          input: effectiveInput,
          executors: deps.executors,
          prior_booking_process_state: bookingProcessState,
          subjects: effectiveBookingSubjects?.subjects ?? null,
          channel_contact: input.channel_contact ?? null,
          now: turnNow,
        });
        if (round2Batch.availability_diagnostic !== undefined) {
          debug.availability_diagnostic = round2Batch.availability_diagnostic;
        }

        // The kernel owns the non-write phase and reduces availability + selection as one
        // atomic state transition. This is the critical ordering guarantee: a fresh
        // availability.check revokes old slot proof before booking preflight can run.
        bookingProcessState = round2Batch.booking_process_state;
        if (deps.bookingProcessStateRepository) {
          deps.bookingProcessStateRepository.saveState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            bookingProcessState,
            (info) => { if (!info.saved) debug.booking_process_state_save = info; },
          ).catch(() => undefined);
        }

        const round2ExecutionSubjectId: SubjectId | null =
          round2BookingPreparation?.ok ? round2BookingPreparation.execution_subject_id : null;
        let round2BookingApplyResolution: BookingApplyResolution | null = round1BookingApplyResolution;
        let round2BookingResult: RuntimeAgentToolResult | null = null;
        let guardedData: GuardedBookingApplyData | null = null;
        let terminalReason = "bounded_tool_batch_final_response";

        if (round2Batch.select_apply_conflict) {
          // The conflict result set is already protocol-complete for the whole batch.
          // No booking write may consume proof produced beside it in this same batch.
          terminalReason = "booking_apply_preflight_select_slot_same_round";
        } else if (pendingBookingApply && round2BookingPreparation && !round2BookingPreparation.ok) {
          terminalReason = round2BookingPreparation.stage === "subject_validation"
            ? "booking_apply_preflight_subject_id_invalid_round2"
            : "booking_apply_preflight_subject_resolution_conflict_round2";
          guardedData = {
            booking_status: "subject_resolution_conflict",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "clarify_subject",
            reason: round2BookingPreparation.reason,
          };
        } else if (pendingBookingApply) {
          const completedBeforeBooking = [...toolResults, ...round2Batch.tool_results];

          if (shouldInterceptNoSlotsBeforeBookingApply({
            pendingToolRequests: round2Requests,
            completedToolResults: completedBeforeBooking,
          })) {
            terminalReason = "booking_apply_preflight_no_slots";
            guardedData = {
              booking_status: "no_available_slots",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_alternative_time",
              reason: "availability_check_returned_no_slots",
            };
          } else {
            const round2Preflight = evaluateBookingApplyPreflight({
              round: 2,
              pendingBookingApply,
              pendingToolRequests: round2Requests,
              pendingTypedPhone: Boolean(effectiveBookingSubjects?.pending_typed_phone),
              hasBookingPhone: hasSubjectOrContactPhone(effectiveInput, round2ExecutionSubjectId),
              activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,
              selectedSlot: bookingProcessState.selected_slot,
              selectedSlotProof: bookingProcessState.selected_slot_proof,
              timezone,
              now: turnNow,
            });

            if (round2Preflight.outcome === "block") {
              terminalReason = round2Preflight.debug_reason;
              if (round2Preflight.past_time_detail) debug.past_time_detail = round2Preflight.past_time_detail;
              if (round2Preflight.missing_fields) debug.missing_fields = round2Preflight.missing_fields;
              guardedData = round2Preflight.guarded_data;
            } else {
              terminalReason = "booking_apply_executed_after_round2_request";
              const bookingExecution = await executeRuntimeToolRequest({
                input: effectiveInput,
                request: pendingBookingApply,
                executors: deps.executors,
                now: turnNow,
                execution_subject_id: round2ExecutionSubjectId,
              });
              round2BookingResult = bookingExecution.tool_result;
              if (round2ExecutionSubjectId) {
                round2BookingApplyResolution = {
                  call_id: pendingBookingApply.call_id,
                  subject_id: round2ExecutionSubjectId,
                };
              }
            }
          }
        }

        if (guardedData && pendingBookingApply) {
          round2BookingResult = {
            tool: "booking.apply",
            call_id: pendingBookingApply.call_id,
            status: "success",
            data: guardedData,
          };
        }

        // Assemble exactly one output per current call id in model request order. The
        // kernel owns read/select results; booking result is appended only after updated
        // state has passed deterministic write guards. Missing ownership fails closed.
        const remainingRound2Results: RuntimeAgentToolResult[] = [
          ...round2Batch.tool_results,
          ...(round2BookingResult ? [round2BookingResult] : []),
        ];
        const resolvedRound2Results: RuntimeAgentToolResult[] = [];
        for (const request of round2Requests) {
          const resultIndex = remainingRound2Results.findIndex((result) =>
            result.tool === request.tool &&
            (request.call_id !== undefined ? result.call_id === request.call_id : true)
          );
          if (resultIndex >= 0) {
            resolvedRound2Results.push(remainingRound2Results.splice(resultIndex, 1)[0]!);
            continue;
          }
          resolvedRound2Results.push({
            tool: request.tool,
            call_id: request.call_id,
            status: "denied",
            error: {
              code: "batch_result_missing",
              message: "Runtime failed closed because this tool request had no deterministic batch result",
            },
          });
        }

        toolResults.push(...resolvedRound2Results);

        const boundedBookingTruth = buildBookingApplyActionTruth(toolResults);
        const boundedAvailabilityAttempt = resolveAuthoritativeAvailabilityAttempt(
          processedToolRequests,
          toolResults,
        );
        const boundedAvailabilityTruth = buildAvailabilityActionTruth(boundedAvailabilityAttempt);
        const boundedAvailabilityPresentation = buildAvailabilityPresentationTruth(boundedAvailabilityAttempt);
        const boundedAppointmentTruth = buildAppointmentDisplayTruth(toolResults);
        const boundedHasBookingToolResult = toolResults.some(
          (r) => r.tool === "availability.check" || r.tool === "booking.apply" || r.tool === "booking.select_slot",
        );
        const boundedGrounded =
          (priorProcessState !== null && hasMeaningfulBookingState(priorProcessState)) ||
          boundedHasBookingToolResult ||
          bookingProcessState.selected_slot != null;
        const boundedVisibleState = buildModelVisibleBookingProcessState({
          state: bookingProcessState,
          priorProcessState,
          bookingStateGrounded: boundedGrounded,
          now: turnNow,
          timezone,
        });

        debug.reason = terminalReason;
        const boundedCall = await invokeRuntimeModelCall({
          caller: deps.caller,
          model: deps.model,
          conversation_id: conversationId,
          system_instruction: systemInstruction,
          message: input.user_message,
          context: composeRuntimeModelContext(callerContext, {
            booking_apply_action_truth: boundedBookingTruth,
            availability_action_truth: boundedAvailabilityTruth,
            availability_presentation_truth: boundedAvailabilityPresentation,
            appointment_display_truth: boundedAppointmentTruth,
            booking_process_state: boundedVisibleState,
          }),
          // Current batch is fully resolved. No tool definitions on the terminal budgeted
          // model step, so no fourth hidden model/tool cycle can begin.
          tool_results: resolvedRound2Results,
        });

        const finalExecutionSubjectId = round2ExecutionSubjectId ?? round1ExecutionSubjectId;
        const finalBookingApplyResolution = round2BookingApplyResolution ?? round1BookingApplyResolution;

        if (!boundedCall.ok) {
          const error = boundedCall.error;
          debug.reason = "bounded_tool_batch_final_call_exception";
          debug.runtime_error = {
            code: "agent_bounded_final_response_failed",
            message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
          };
          debug.caller_exception = buildCallerExceptionDiagnostics(error, {
            stage: "forced_finalization",
            locale: input.locale,
            conversationId,
            toolResults,
            bookingApplyActionTruth: boundedBookingTruth,
          });
          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: boundedBookingTruth
              ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
              : buildMultiRoundFallbackReply(input.locale),
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: processedToolRequests,
            tool_results: toolResults,
            debug,
            ...(finalExecutionSubjectId != null ? { execution_subject_id: finalExecutionSubjectId } : {}),
            ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
            ...(finalBookingApplyResolution != null ? { booking_apply_resolution: finalBookingApplyResolution } : {}),
          };
        }

        const boundedOutput = boundedCall.output;
        conversationId = boundedCall.conversation_id;

        if (boundedOutput.type === "tool_requests") {
          processedToolRequests.push(...boundedOutput.tool_requests);
          debug.reason = "bounded_tool_batch_budget_exhausted";
          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: boundedBookingTruth
              ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
              : buildMultiRoundFallbackReply(input.locale),
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: processedToolRequests,
            tool_results: toolResults,
            debug,
            ...(finalExecutionSubjectId != null ? { execution_subject_id: finalExecutionSubjectId } : {}),
            ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
            ...(finalBookingApplyResolution != null ? { booking_apply_resolution: finalBookingApplyResolution } : {}),
          };
        }

        if (isMalformedFinalResponse(boundedOutput)) {
          debug.reason = "malformed_bounded_tool_batch_final_response";
          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: boundedBookingTruth
              ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
              : buildMultiRoundFallbackReply(input.locale),
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: processedToolRequests,
            tool_results: toolResults,
            debug,
            ...(finalExecutionSubjectId != null ? { execution_subject_id: finalExecutionSubjectId } : {}),
            ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
            ...(finalBookingApplyResolution != null ? { booking_apply_resolution: finalBookingApplyResolution } : {}),
          };
        }

        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        const channel = typeof input.business_context?.channel === "string"
          ? input.business_context.channel
          : undefined;
        let finalUi = maybeAttachPhoneRequestUI(
          boundedVisibleState,
          boundedOutput.final_response.ui,
          channel,
        );
        if (guardedData?.required_next_action === "ask_for_phone") {
          const captureUi = buildPhoneCaptureUi(channel);
          if (captureUi) {
            finalUi = {
              ...finalUi,
              ...captureUi,
              telegram: { ...(finalUi?.telegram ?? {}), ...(captureUi.telegram ?? {}) },
            };
          }
        }

        return {
          final_patient_reply: boundedOutput.final_response.final_patient_reply,
          conversation_id: conversationId,
          tool_requests: processedToolRequests,
          tool_results: toolResults,
          debug,
          ui: finalUi,
          ...(boundedOutput.final_response.subject_intent != null ? { subject_intent: boundedOutput.final_response.subject_intent } : {}),
          ...(boundedOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: boundedOutput.final_response.phone_ownership_intent } : {}),
          ...(finalExecutionSubjectId != null ? { execution_subject_id: finalExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(finalBookingApplyResolution != null ? { booking_apply_resolution: finalBookingApplyResolution } : {}),
        };
      }

'''

source = source[:start] + new_branch + source[end:]
LOOP.write_text(source)

# Fix the R3r fixtures to the actual BookingProcessState contract and keep evidence fresh.
fixture_old = '''  return {\n    trusted_phone_available: true,\n    selected_slot: { starts_at: "2099-08-22T10:00:00" },\n    last_available_slots: [{ starts_at: "2099-08-22T10:00:00" }],\n    active_availability_evidence: {\n      availability_call_id: "avail_old",\n      requested_date: "2099-08-22",\n      requested_time: null,\n      allowed_slot_keys: ["2099-08-22T10:00"],\n    },\n    selected_slot_proof: {\n      subject_id: "subject_1",\n      availability_call_id: "avail_old",\n      slot_key: "2099-08-22T10:00",\n    },\n    updated_at: NOW.toISOString(),\n  };'''
fixture_new = '''  return {\n    service_reason: "cleaning",\n    first_name: "Eva",\n    last_name: "Novak",\n    selected_slot: { starts_at: "2099-08-22T10:00:00" },\n    last_available_slots: [{ starts_at: "2099-08-22T10:00:00" }],\n    active_availability_evidence: {\n      availability_call_id: "avail_old",\n      requested_date: "2099-08-22",\n      requested_time: null,\n      allowed_slot_keys: ["2099-08-22T10:00"],\n      checked_at: NOW.toISOString(),\n    },\n    selected_slot_proof: {\n      subject_id: "subject_1",\n      availability_call_id: "avail_old",\n      slot_key: "2099-08-22T10:00",\n    },\n    phone_trusted: true,\n    phone_source: "telegram_contact_button",\n    next_action: "ready_for_booking_apply",\n    proof: {\n      service_known: true,\n      name_known: true,\n      slot_known: true,\n      trusted_phone_known: true,\n      ready_for_booking_apply: true,\n    },\n  };'''
for test_path in [
    Path("tests/r3rRuntimeToolBatchKernel.test.ts"),
    Path("tests/r3rWriteBearingBatchIntegration.test.ts"),
]:
    text = test_path.read_text()
    count = text.count(fixture_old)
    if count != 1:
        raise SystemExit(f"{test_path}: expected one old fixture, found {count}")
    test_path.write_text(text.replace(fixture_old, fixture_new, 1))

print("R3r guarded patch applied")

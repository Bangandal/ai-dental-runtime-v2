from pathlib import Path
import re

loop_path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = loop_path.read_text()

# Import the shared batch-content protocol guard.
anchor = 'import { executeBookingSelectSlotBatch } from "./bookingSelectSlot.ts";\n'
assert source.count(anchor) == 1
source = source.replace(
    anchor,
    anchor + 'import { resolveBookingSelectApplyBatchConflict } from "./bookingSelectApplyBatchConflict.ts";\n',
    1,
)

# Replace first-path hand-written Guard S result construction with the shared helper.
start = source.index('      // Guard S (round 1) — same-round booking.select_slot + booking.apply:')
end = source.index('      // Guard J (first tool batch)', start)
old = source[start:end]
new = '''      // Same-batch dependency guard — booking.apply cannot consume a booking.select_slot
      // result emitted beside it in the same model tool batch. The shared helper closes every
      // call id and selection state is persisted before the model sees the results.
      const round1SelectApplyConflict = resolveBookingSelectApplyBatchConflict({
        requests: toolRequests,
        activeEvidence: priorProcessState?.active_availability_evidence ?? null,
        subjects: effectiveBookingSubjects?.subjects ?? null,
      });
      let guardSFired = false;

      if (round1SelectApplyConflict) {
        toolResults.push(...round1SelectApplyConflict.tool_results);

        bookingProcessState = computeBookingProcessState({
          prior: priorProcessState,
          channelContact: input.channel_contact,
          selectSlotData: round1SelectApplyConflict.selection.success_data,
          selectSlotAttemptedThisTurn: round1SelectApplyConflict.selection.attempted,
          now: turnNow,
        });

        if (deps.bookingProcessStateRepository) {
          deps.bookingProcessStateRepository.saveState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            bookingProcessState,
            (info) => { if (!info.saved) debug.booking_process_state_save = info; },
          ).catch(() => undefined);
        }

        // Historical diagnostic label retained until the numbered model-call shell is removed.
        debug.reason = "booking_apply_preflight_select_slot_same_round";
        guardSFired = true;
      }

'''
source = source[:start] + new + source[end:]

# Replace round-2 preparation + selection region so same-batch conflict has the same
# priority as first-path Guard S, while preserving registry bootstrap side effects.
start = source.index('        // 3. Prepare/freeze booking target through the same round-agnostic boundary used')
end = source.index('        // 6. No-slots gate', start)
old2 = source[start:end]
new2 = '''        // 3. Prepare/freeze booking target through the same round-agnostic boundary used
        // by the first tool batch. Same-batch select/apply conflict has priority over
        // booking.apply subject-validation, matching the first-path protocol rule.
        let round2ExecutionSubjectId: SubjectId | null = null;
        let round2SelectApplyConflict: ReturnType<typeof resolveBookingSelectApplyBatchConflict> = null;
        if (pendingBookingApply) {
          const round2BookingPreparation = prepareBookingApplyExecution({
            booking_apply: pendingBookingApply,
            booking_subjects: effectiveBookingSubjects,
            channel_contact: input.channel_contact ?? null,
            current_turn_typed_phone: input.current_turn_typed_phone ?? null,
          });

          effectiveBookingSubjects = round2BookingPreparation.effective_booking_subjects;
          effectiveInput = effectiveBookingSubjects !== (input.booking_subjects ?? null)
            ? { ...input, booking_subjects: effectiveBookingSubjects }
            : input;
          if (round2BookingPreparation.bootstrapped_registry) {
            bootstrappedRegistry = round2BookingPreparation.bootstrapped_registry;
          }

          round2SelectApplyConflict = resolveBookingSelectApplyBatchConflict({
            requests: secondOutput.tool_requests,
            activeEvidence: bookingProcessState.active_availability_evidence,
            subjects: effectiveBookingSubjects?.subjects ?? null,
          });

          if (!round2SelectApplyConflict && !round2BookingPreparation.ok) {
            debug.reason = round2BookingPreparation.stage === "subject_validation"
              ? "booking_apply_preflight_subject_id_invalid_round2"
              : "booking_apply_preflight_subject_resolution_conflict_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "subject_resolution_conflict",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "clarify_subject",
                reason: round2BookingPreparation.reason,
              },
              previousToolResults: toolResults,
              toolRequests: processedToolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
              booking_subjects_after_resolution: bootstrappedRegistry,
            });
          }

          if (!round2SelectApplyConflict && round2BookingPreparation.ok) {
            round2ExecutionSubjectId = round2BookingPreparation.execution_subject_id;
          }
        }

        const round2SlotSelection = round2SelectApplyConflict?.selection ?? executeBookingSelectSlotBatch({
          requests: secondOutput.tool_requests,
          activeEvidence: bookingProcessState.active_availability_evidence,
          subjects: effectiveBookingSubjects?.subjects ?? null,
        });

        if (round2SelectApplyConflict) {
          toolResults.push(...round2SelectApplyConflict.tool_results);
          bookingProcessState = computeBookingProcessState({
            prior: bookingProcessState,
            channelContact: input.channel_contact,
            selectSlotData: round2SelectApplyConflict.selection.success_data,
            selectSlotAttemptedThisTurn: round2SelectApplyConflict.selection.attempted,
            now: turnNow,
          });

          if (deps.bookingProcessStateRepository) {
            deps.bookingProcessStateRepository.saveState(
              { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
              bookingProcessState,
              (info) => { if (!info.saved) debug.booking_process_state_save = info; },
            ).catch(() => undefined);
          }

          debug.reason = "booking_apply_preflight_select_slot_same_round";
        } else if (round2SlotSelection.attempted) {
          toolResults.push(...round2SlotSelection.tool_results);
          bookingProcessState = computeBookingProcessState({
            prior: bookingProcessState,
            channelContact: input.channel_contact,
            selectSlotData: round2SlotSelection.success_data,
            // Any selection attempt, including failed/ambiguous, revokes the previous proof.
            selectSlotAttemptedThisTurn: true,
            now: turnNow,
          });

          if (deps.bookingProcessStateRepository) {
            deps.bookingProcessStateRepository.saveState(
              { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
              bookingProcessState,
              (info) => { if (!info.saved) debug.booking_process_state_save = info; },
            ).catch(() => undefined);
          }
        }

'''
source = source[:start] + new2 + source[end:]

# Same-batch conflict already owns the booking.apply result and closes every current call id.
source = source.replace(
    '        if (shouldInterceptNoSlotsBeforeBookingApply({\n',
    '        if (!round2SelectApplyConflict && shouldInterceptNoSlotsBeforeBookingApply({\n',
    1,
)
source = source.replace(
    '        if (pendingBookingApply) {\n          const round2Preflight = evaluateBookingApplyPreflight({',
    '        if (pendingBookingApply && !round2SelectApplyConflict) {\n          const round2Preflight = evaluateBookingApplyPreflight({',
    1,
)

if source.count('resolveBookingSelectApplyBatchConflict({') != 2:
    raise AssertionError(f"expected two shared batch-guard calls, got {source.count('resolveBookingSelectApplyBatchConflict({')}")
if 'guard_s_same_round_protocol' in source:
    raise AssertionError('legacy loop still owns Guard S protocol result construction')

loop_path.write_text(source)

# Replace the old R-6 characterization that allowed same-batch select+apply in round 2.
test_path = Path("tests/slotEvidenceBinding.test.ts")
tests = test_path.read_text()
start = tests.index('// ── R-6: round-2 booking.select_slot + booking.apply is round-independent')
end = tests.index('// ── S: same-round booking.select_slot + booking.apply → Guard S', start)
replacement = '''// ── R-6: same-batch booking.select_slot + booking.apply is phase-independent ──\n\n// R3p: booking.apply depends on the completed RESULT of booking.select_slot. Emitting both\n// in one model tool batch is therefore blocked regardless of whether the batch is first or later.\ntest("R-6: later batch booking.select_slot plus booking.apply — selection succeeds, booking is blocked, executor call count=0", async () => {\n  let executorCallCount = 0;\n  const loop = createRuntimeAgentLoop({\n    model: "test-model",\n    now: new Date("2028-01-14T20:00:00Z"),\n    caller: (async (input) => {\n      const results = input.input.tool_results ?? [];\n      if (!results.length && input.input.tool_definitions) {\n        return {\n          type: "tool_requests" as const,\n          tool_requests: [{ tool: "availability.check", call_id: "ac_r6", arguments: { requested_date: "2028-01-15", requested_time: null } }],\n        };\n      }\n      if (results.some((r: { tool: string }) => r.tool === "availability.check")) {\n        return {\n          type: "tool_requests" as const,\n          tool_requests: [\n            { tool: "booking.select_slot", call_id: "ss_r6", arguments: { subject_id: "subject_1", requested_date: "2028-01-15", requested_time: "10:00" } },\n            { tool: "booking.apply", call_id: "ba_r6", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } },\n          ],\n        };\n      }\n      return { type: "final_response" as const, final_response: { final_patient_reply: "Слот выбран. Запись нужно подтвердить следующим действием." } };\n    }) as RuntimeAgentCaller,\n    executors: {\n      "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2028-01-15T10:00:00" }] } }),\n      "booking.apply": async () => {\n        executorCallCount++;\n        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };\n      },\n    },\n    bookingProcessStateRepository: makeSlotStateRepo("2028-01-15T10:00:00", "subject_1"),\n  });\n\n  const result = await loop.runTurn({\n    clinic_id: "clinic_1", contact_id: "contact_r6", case_id: null,\n    user_message: "запиши", locale: "ru", trace_id: "tr_r6",\n    channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" },\n  });\n\n  assert.equal(executorCallCount, 0, "R-6: same-batch booking.apply must not execute");\n  const ssResult = result.tool_results.find((r) => r.call_id === "ss_r6");\n  assert.ok(ssResult, "R-6: select_slot result must be present");\n  assert.equal(ssResult!.status, "success", "R-6: valid later-batch select_slot must still succeed");\n  const baResult = result.tool_results.find((r) => r.call_id === "ba_r6");\n  assert.ok(baResult, "R-6: blocked booking.apply result must be present");\n  assert.equal((baResult!.data as Record<string, unknown>)?.booking_status, "slot_not_verified");\n  assert.equal((baResult!.data as Record<string, unknown>)?.reason, "select_slot_and_booking_apply_same_round");\n});\n\n'''
tests = tests[:start] + replacement + tests[end:]
test_path.write_text(tests)

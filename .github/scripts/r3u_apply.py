from pathlib import Path

p = Path("src/runtime/runtimeAgentLoopLegacy.ts")
s = p.read_text()

# Imports: add the new complete batch handler + temporary legacy debug adapter.
anchor = 'import { executeRuntimeToolBatchKernel, completeRuntimeToolBatchWithBookingResult } from "./runtimeToolBatchKernel.ts";\n'
replacement = (
    anchor
    + 'import { executeRuntimeTurnToolBatch } from "./runtimeTurnToolBatch.ts";\n'
    + 'import { getLegacyRuntimeTurnToolBatchDebugReason } from "./runtimeTurnToolBatchLegacyDebug.ts";\n'
)
if s.count(anchor) != 1:
    raise SystemExit(f"kernel import anchor count={s.count(anchor)}")
s = s.replace(anchor, replacement, 1)

# Replace first-batch booking/read/select execution block, leaving the historical
# multiple-booking precheck and availability-past-time pre-execution stop above it.
start_marker = '      const bookingApplyRound1 = toolRequests.find((r) => r.tool === "booking.apply") ?? null;\n'
end_marker = '      const bookingActionTruth = buildBookingApplyActionTruth(toolResults);\n'
start = s.find(start_marker)
end = s.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit(f"round1 markers not found start={start} end={end}")
if s.find(start_marker, start + 1) >= 0:
    raise SystemExit("round1 start marker not unique")

round1 = '''      const round1TurnBatch = await executeRuntimeTurnToolBatch({
        requests: toolRequests,
        input,
        executors: deps.executors,
        booking_process_state: bookingProcessState,
        booking_subjects: input.booking_subjects ?? null,
        previous_tool_results: [],
        previous_booking_apply_resolution: null,
        now: turnNow,
        timezone,
      });

      bookingProcessState = round1TurnBatch.booking_process_state;
      let effectiveBookingSubjects: BookingSubjectsState | null = round1TurnBatch.effective_booking_subjects;
      let bootstrappedRegistry: BookingSubjectsState | null = round1TurnBatch.bootstrapped_registry;
      const round1ExecutionSubjectId: SubjectId | null = round1TurnBatch.execution_subject_id;
      let round1BookingApplyResolution: BookingApplyResolution | null = round1TurnBatch.booking_apply_resolution;
      const round1GuardedData: GuardedBookingApplyData | null = round1TurnBatch.guarded_booking_apply_data;

      if (round1TurnBatch.availability_diagnostic !== undefined) {
        debug.availability_diagnostic = round1TurnBatch.availability_diagnostic;
      }
      const round1DebugReason = getLegacyRuntimeTurnToolBatchDebugReason(round1TurnBatch, 1);
      if (round1DebugReason) debug.reason = round1DebugReason;
      if (round1TurnBatch.past_time_detail) debug.past_time_detail = round1TurnBatch.past_time_detail;
      if (round1TurnBatch.missing_fields) debug.missing_fields = round1TurnBatch.missing_fields;

      toolResults.push(...round1TurnBatch.tool_results);
      if (deps.bookingProcessStateRepository) {
        deps.bookingProcessStateRepository.saveState(
          { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
          bookingProcessState,
          (info) => { if (!info.saved) debug.booking_process_state_save = info; },
        ).catch(() => undefined);
      }

'''
s = s[:start] + round1 + s[end:]

# Replace second-batch complete execution block. Start immediately after the current
# requests have been appended; stop before the truth/context assembly.
start_marker2 = '        const allRound2BookingRequests = round2Requests.filter((r) => r.tool === "booking.apply");\n'
end_marker2 = '        const boundedBookingTruth = buildBookingApplyActionTruth(toolResults);\n'
start2 = s.find(start_marker2)
end2 = s.find(end_marker2, start2)
if start2 < 0 or end2 < 0:
    raise SystemExit(f"round2 markers not found start={start2} end={end2}")
if s.find(start_marker2, start2 + 1) >= 0:
    raise SystemExit("round2 start marker not unique")

round2 = '''        const round2TurnBatch = await executeRuntimeTurnToolBatch({
          requests: round2Requests,
          input: effectiveBookingSubjects !== (input.booking_subjects ?? null)
            ? { ...input, booking_subjects: effectiveBookingSubjects }
            : input,
          executors: deps.executors,
          booking_process_state: bookingProcessState,
          booking_subjects: effectiveBookingSubjects,
          previous_tool_results: toolResults,
          previous_booking_apply_resolution: round1BookingApplyResolution,
          now: turnNow,
          timezone,
        });

        bookingProcessState = round2TurnBatch.booking_process_state;
        effectiveBookingSubjects = round2TurnBatch.effective_booking_subjects;
        if (round2TurnBatch.bootstrapped_registry) {
          bootstrappedRegistry = round2TurnBatch.bootstrapped_registry;
        }
        if (round2TurnBatch.availability_diagnostic !== undefined) {
          debug.availability_diagnostic = round2TurnBatch.availability_diagnostic;
        }
        if (round2TurnBatch.past_time_detail) debug.past_time_detail = round2TurnBatch.past_time_detail;
        if (round2TurnBatch.missing_fields) debug.missing_fields = round2TurnBatch.missing_fields;

        const round2ExecutionSubjectId: SubjectId | null = round2TurnBatch.execution_subject_id;
        let round2BookingApplyResolution: BookingApplyResolution | null =
          round2TurnBatch.booking_apply_resolution ?? round1BookingApplyResolution;
        const guardedData: GuardedBookingApplyData | null = round2TurnBatch.guarded_booking_apply_data;
        const terminalReason = getLegacyRuntimeTurnToolBatchDebugReason(round2TurnBatch, 2)
          ?? "bounded_tool_batch_final_response";
        const resolvedRound2Results = round2TurnBatch.tool_results;
        toolResults.push(...resolvedRound2Results);

        if (deps.bookingProcessStateRepository) {
          deps.bookingProcessStateRepository.saveState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            bookingProcessState,
            (info) => { if (!info.saved) debug.booking_process_state_save = info; },
          ).catch(() => undefined);
        }

'''
s = s[:start2] + round2 + s[end2:]

p.write_text(s)

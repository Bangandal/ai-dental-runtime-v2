from pathlib import Path

p = Path("src/runtime/runtimeAgentLoopLegacy.ts")
s = p.read_text()

# Imports: main runTurn delegates orchestration to the new roundless owner.
replacements = [
    (
        'import { isPastBookingTime, buildPastTimeReply, getTodayInTimezone } from "./bookingPreflight.ts";\n',
        'import { buildPastTimeReply } from "./bookingPreflight.ts";\n',
        'booking preflight import',
    ),
    (
        'import { buildAvailabilityPresentationTruth } from "./availabilityPresentationTruth.ts";\n',
        '',
        'availability presentation import',
    ),
    (
        'import { buildAvailabilityActionTruth, resolveAuthoritativeAvailabilityAttempt, findLastAvailabilityRequest } from "./availabilityActionTruth.ts";\n',
        '',
        'availability action import',
    ),
    (
        'import { buildAppointmentDisplayTruth } from "./appointmentDisplayTruth.ts";\n',
        '',
        'appointment truth import',
    ),
    (
        'import { executeRuntimeTurnToolBatch } from "./runtimeTurnToolBatch.ts";\nimport { getLegacyRuntimeTurnToolBatchDebugReason } from "./runtimeTurnToolBatchLegacyDebug.ts";\n',
        'import { runRuntimeTurnModelToolOrchestration } from "./runtimeTurnModelToolOrchestrator.ts";\n',
        'turn batch imports',
    ),
    (
        'import { createRuntimeModelIterationState, invokeRuntimeModelIteration } from "./runtimeModelIteration.ts";\n',
        'import { createRuntimeModelIterationState } from "./runtimeModelIteration.ts";\n',
        'model iteration import',
    ),
]
for old, new, label in replacements:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    s = s.replace(old, new, 1)

start_marker = '      // First call: grounded only if prior state has meaningful booking data.\n'
end_marker = '    },\n  };\n}\n\n// ── Multiple-blocked booking.apply helper'
start = s.find(start_marker)
end = s.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit(f"runTurn replacement markers not found start={start} end={end}")
if s.find(start_marker, start + 1) >= 0:
    raise SystemExit("runTurn start marker not unique")

new_body = r'''      const persistBookingProcessState = (state: BookingProcessState): void => {
        if (!deps.bookingProcessStateRepository) return;
        deps.bookingProcessStateRepository.saveState(
          { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
          state,
          (info) => { if (!info.saved) debug.booking_process_state_save = info; },
        ).catch(() => undefined);
      };

      debug.llm_calls = buildRuntimeLlmCallDebug({ main_agent_called: true });
      const orchestration = await runRuntimeTurnModelToolOrchestration({
        model_state: modelIteration,
        caller: deps.caller,
        model: deps.model,
        system_instruction: systemInstruction,
        input,
        caller_context: callerContext,
        executors: deps.executors,
        prior_booking_process_state: priorProcessState,
        initial_booking_process_state: bookingProcessState,
        now: turnNow,
        timezone,
        on_booking_process_state: persistBookingProcessState,
      });

      modelIteration = orchestration.model_state;
      conversationId = modelIteration.conversation_id;
      const turnState = orchestration.domain_state;
      bookingProcessState = turnState.booking_process_state;

      if (turnState.tool_call_args.length > 0) debug.tool_call_args = turnState.tool_call_args;
      if (turnState.availability_diagnostic !== undefined) {
        debug.availability_diagnostic = turnState.availability_diagnostic;
      }
      if (turnState.past_time_detail) debug.past_time_detail = turnState.past_time_detail;
      if (turnState.missing_fields) debug.missing_fields = turnState.missing_fields;
      if (turnState.last_debug_reason) debug.reason = turnState.last_debug_reason;

      const bookingActionTruth = turnState.model_projection.booking_apply_action_truth;
      const channel = typeof input.business_context?.channel === "string"
        ? input.business_context.channel
        : undefined;

      const withExecutionMetadata = <T extends Record<string, unknown>>(result: T): T & Record<string, unknown> => ({
        ...result,
        ...(turnState.execution_subject_id != null
          ? { execution_subject_id: turnState.execution_subject_id }
          : {}),
        ...(turnState.effective_booking_subjects != null
          ? { booking_subjects_after_resolution: turnState.effective_booking_subjects }
          : {}),
        ...(turnState.booking_apply_resolution != null
          ? { booking_apply_resolution: turnState.booking_apply_resolution }
          : {}),
      });

      if (orchestration.kind === "batch_aborted") {
        debug.reason = orchestration.reason;
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return withExecutionMetadata({
          final_patient_reply: orchestration.reason === "availability_preflight_past_time"
            ? buildPastTimeReply(input.locale)
            : buildMultiRoundFallbackReply(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: turnState.processed_tool_requests,
          tool_results: turnState.tool_results,
          debug,
        }) as RuntimeAgentTurnResult;
      }

      if (orchestration.kind === "call_failed") {
        const error = orchestration.error;
        if (orchestration.call_number <= 1) {
          debug.runtime_error = {
            code: "agent_caller_failed",
            message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
          };
          debug.reason = "agent_first_call_exception";
          debug.caller_exception = buildCallerExceptionDiagnostics(error, {
            stage: "first_call",
            locale: input.locale,
            conversationId,
          });
          await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: buildMalformedResponseFallback(input.locale),
            conversation_id: conversationId,
            conversation_id_resumable: false,
            tool_requests: [],
            tool_results: [],
            debug,
          };
        }

        if (orchestration.call_number === 2) {
          debug.runtime_error = {
            code: "agent_final_response_failed",
            message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
          };
          debug.reason = bookingActionTruth
            ? "agent_second_call_exception_booking_fallback"
            : "agent_second_call_exception_generic_fallback";
          debug.caller_exception = buildCallerExceptionDiagnostics(error, {
            stage: "second_call",
            locale: input.locale,
            conversationId,
            toolResults: turnState.tool_results,
            bookingApplyActionTruth: bookingActionTruth,
          });
          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return withExecutionMetadata({
            final_patient_reply: bookingActionTruth
              ? buildBookingApplyEmergencyFallback(turnState.tool_results, input.locale)
              : buildMalformedResponseFallback(input.locale),
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: turnState.processed_tool_requests,
            tool_results: turnState.tool_results,
            debug,
          }) as RuntimeAgentTurnResult;
        }

        debug.reason = "bounded_tool_batch_final_call_exception";
        debug.runtime_error = {
          code: "agent_bounded_final_response_failed",
          message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        };
        debug.caller_exception = buildCallerExceptionDiagnostics(error, {
          stage: "forced_finalization",
          locale: input.locale,
          conversationId,
          toolResults: turnState.tool_results,
          bookingApplyActionTruth: bookingActionTruth,
        });
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return withExecutionMetadata({
          final_patient_reply: bookingActionTruth
            ? buildBookingApplyEmergencyFallback(turnState.tool_results, input.locale)
            : buildMultiRoundFallbackReply(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: turnState.processed_tool_requests,
          tool_results: turnState.tool_results,
          debug,
        }) as RuntimeAgentTurnResult;
      }

      if (orchestration.kind === "budget_exhausted") {
        debug.reason = "model_call_budget_exhausted";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return withExecutionMetadata({
          final_patient_reply: bookingActionTruth
            ? buildBookingApplyEmergencyFallback(turnState.tool_results, input.locale)
            : buildMultiRoundFallbackReply(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: turnState.processed_tool_requests,
          tool_results: turnState.tool_results,
          debug,
        }) as RuntimeAgentTurnResult;
      }

      if (orchestration.kind === "terminal_tool_request") {
        debug.terminal_tool_request_ignored = true;
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return withExecutionMetadata({
          final_patient_reply: bookingActionTruth
            ? buildBookingApplyEmergencyFallback(turnState.tool_results, input.locale)
            : buildMalformedResponseFallback(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: turnState.processed_tool_requests,
          tool_results: turnState.tool_results,
          debug,
          ...(turnState.last_guarded_booking_apply_data?.required_next_action === "ask_for_phone"
            ? { ui: buildPhoneCaptureUi(channel) }
            : {}),
        }) as RuntimeAgentTurnResult;
      }

      if (orchestration.kind === "tool_request_at_budget_limit") {
        debug.reason = "bounded_tool_batch_budget_exhausted";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return withExecutionMetadata({
          final_patient_reply: bookingActionTruth
            ? buildBookingApplyEmergencyFallback(turnState.tool_results, input.locale)
            : buildMultiRoundFallbackReply(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: [...turnState.processed_tool_requests, ...orchestration.requests],
          tool_results: turnState.tool_results,
          debug,
        }) as RuntimeAgentTurnResult;
      }

      const finalOutput = orchestration.output;
      if (isMalformedFinalResponse(finalOutput)) {
        if (orchestration.call_number <= 1) {
          debug.reason = "malformed_first_model_response";
          await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: buildMalformedResponseFallback(input.locale),
            conversation_id: conversationId,
            conversation_id_resumable: false,
            tool_requests: [],
            tool_results: [],
            debug,
          };
        }

        if (orchestration.call_number === 2) {
          debug.reason = bookingActionTruth
            ? "malformed_second_model_response_booking_fallback"
            : "malformed_second_model_response_generic_fallback";
          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return withExecutionMetadata({
            final_patient_reply: bookingActionTruth
              ? buildBookingApplyEmergencyFallback(turnState.tool_results, input.locale)
              : buildMalformedResponseFallback(input.locale),
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: turnState.processed_tool_requests,
            tool_results: turnState.tool_results,
            debug,
          }) as RuntimeAgentTurnResult;
        }

        debug.reason = "malformed_bounded_tool_batch_final_response";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return withExecutionMetadata({
          final_patient_reply: bookingActionTruth
            ? buildBookingApplyEmergencyFallback(turnState.tool_results, input.locale)
            : buildMultiRoundFallbackReply(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: turnState.processed_tool_requests,
          tool_results: turnState.tool_results,
          debug,
        }) as RuntimeAgentTurnResult;
      }

      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
      persistBookingProcessState(bookingProcessState);
      let finalUi = maybeAttachPhoneRequestUI(
        turnState.model_projection.visible_booking_process_state,
        finalOutput.final_response.ui,
        channel,
      );
      finalUi = forcePhoneCaptureUiForGuard(
        turnState.last_guarded_booking_apply_data,
        finalUi,
        channel,
      );

      return withExecutionMetadata({
        final_patient_reply: finalOutput.final_response.final_patient_reply,
        conversation_id: conversationId,
        tool_requests: turnState.processed_tool_requests,
        tool_results: turnState.tool_results,
        debug,
        ui: finalUi,
        ...(finalOutput.final_response.subject_intent != null
          ? { subject_intent: finalOutput.final_response.subject_intent }
          : {}),
        ...(finalOutput.final_response.phone_ownership_intent != null
          ? { phone_ownership_intent: finalOutput.final_response.phone_ownership_intent }
          : {}),
      }) as RuntimeAgentTurnResult;
'''

s = s[:start] + new_body + s[end:]

# Main path must be free of historical transport/business phase names after migration.
main = s[:s.find('// ── Multiple-blocked booking.apply helper')]
for forbidden in [
    'firstStep', 'firstOutput', 'secondStep', 'secondOutput', 'boundedStep', 'boundedOutput',
    'round1TurnBatch', 'round2TurnBatch', 'executeRuntimeTurnToolBatch({',
    'invokeRuntimeModelIteration({',
]:
    if forbidden in main:
        raise SystemExit(f"legacy main path still contains phase-specific owner: {forbidden}")
if main.count('runRuntimeTurnModelToolOrchestration({') != 1:
    raise SystemExit('legacy main path must delegate to roundless orchestrator exactly once')

p.write_text(s)

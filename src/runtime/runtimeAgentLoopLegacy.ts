import {
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  buildRuntimeAgentSystemInstruction,
  type AgentUiActions,
  type BookingApplyResolution,
  type OpenAIRuntimeAgent,
  type RuntimeAgentToolRequest,
  type RuntimeAgentToolResult,
  type RuntimeAgentTurnInput,
  type RuntimeAgentTurnResult,
} from "./openaiRuntimeAgent.ts";
import type { SubjectId, BookingSubjectsState } from "./bookingSubjectsState.ts";
import type { ToolExecutorRegistry } from "./toolExecutor.ts";
import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";
import { buildModelVisibleCallerContext, composeRuntimeModelContext } from "./modelVisibleCallerContext.ts";
import { buildRuntimeLlmCallDebug } from "./llmCallDebug.ts";
import { buildBookingApplyActionTruth, buildBookingApplyEmergencyFallback } from "./bookingApplyGuard.ts";
import { buildCallerExceptionDiagnostics, sanitizeErrorMessage } from "./callerExceptionDiagnostics.ts";
import { hasTrustedPhone, hasBookingApplyPending } from "./bookingContactGuard.ts";
import { isPastBookingTime, buildPastTimeReply, getTodayInTimezone } from "./bookingPreflight.ts";
import { buildAvailabilityPresentationTruth } from "./availabilityPresentationTruth.ts";
import { buildAvailabilityActionTruth, resolveAuthoritativeAvailabilityAttempt, findLastAvailabilityRequest } from "./availabilityActionTruth.ts";
import { buildAppointmentDisplayTruth } from "./appointmentDisplayTruth.ts";
import {
  computeBookingProcessState,
  buildModelVisibleBookingProcessState,
  hasMeaningfulBookingState,
  type BookingProcessStateRepository,
  type BookingProcessState,
  type ModelVisibleBookingProcessState,
} from "./bookingProcessState.ts";
import { buildPhoneCaptureUi, sanitizePhoneCaptureUiForChannel } from "./channelCapabilityPolicy.ts";
import { executeRuntimeTurnToolBatch } from "./runtimeTurnToolBatch.ts";
import { getLegacyRuntimeTurnToolBatchDebugReason } from "./runtimeTurnToolBatchLegacyDebug.ts";
import { invokeRuntimeModelCall, type RuntimeAgentCaller, type RuntimeAgentCallerInput, type RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";
import { createRuntimeModelIterationState, invokeRuntimeModelIteration } from "./runtimeModelIteration.ts";
export type { RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";
export { buildSubjectAwarePhoneFields, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";

export interface CreateRuntimeAgentLoopDeps {
  model: string;
  caller: RuntimeAgentCaller;
  executors: ToolExecutorRegistry;
  conversationMemoryRepository?: ConversationMemoryRepository;
  bookingProcessStateRepository?: BookingProcessStateRepository;
  now?: Date;
  timezone?: string;
}

export function createRuntimeAgentLoop(deps: CreateRuntimeAgentLoopDeps): OpenAIRuntimeAgent {
  return {
    async runTurn(input: RuntimeAgentTurnInput): Promise<RuntimeAgentTurnResult> {
      // Per-turn clock: always a real Date so past-time guards and system instruction
      // are correct even when the caller does not inject deps.now (production).
      // Must be created here, not at loop-construction time, to avoid freezing time.
      const turnNow = deps.now ?? new Date();
      const timezone = deps.timezone ?? "Europe/Prague";

      const debug: Record<string, unknown> = { llm_calls: buildRuntimeLlmCallDebug() };
      const systemInstruction = buildRuntimeAgentSystemInstruction({
        now: turnNow,
        timezone,
        is_new_conversation: input.is_first_patient_turn ?? false,
      });
      let conversationId = input.conversation_id ?? null;

      if (!conversationId && deps.conversationMemoryRepository) {
        try {
          const memoryResult = await deps.conversationMemoryRepository.getConversationMemory({
            clinic_id: input.clinic_id,
            contact_id: input.contact_id,
            case_id: input.case_id,
          });
          debug.memory_loaded = memoryResult.ok;
          if (memoryResult.ok) {
            conversationId = memoryResult.data.conversation_id;
          } else {
            debug.memory_load_error = memoryResult.error;
          }
        } catch (error) {
          debug.memory_loaded = false;
          debug.memory_load_error = error instanceof Error ? error.message : String(error);
        }
      }

      let modelIteration = createRuntimeModelIterationState(conversationId);

      const callerContext = buildModelVisibleCallerContext(input);

      // Load prior booking process state; compute initial per-turn state from it.
      let priorProcessState: Partial<BookingProcessState> | null = null;
      if (deps.bookingProcessStateRepository) {
        try {
          priorProcessState = await deps.bookingProcessStateRepository.loadState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            (info) => { debug.booking_process_state = info; },
          );
        } catch (err) {
          debug.booking_process_state = {
            loaded: false,
            reason: "rpc_error",
            error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          };
        }
      }

      // Initial state derived from prior state (no tool results yet this turn)
      let bookingProcessState = computeBookingProcessState({
        prior: priorProcessState,
        channelContact: input.channel_contact,
        now: turnNow,
      });

      // First call: grounded only if prior state has meaningful booking data.
      // Non-booking tool results and empty prior state do NOT make it grounded.
      const firstCallGrounded =
        priorProcessState !== null && hasMeaningfulBookingState(priorProcessState);
      const firstCallVisibleState = buildModelVisibleBookingProcessState({
        state: bookingProcessState,
        priorProcessState,
        bookingStateGrounded: firstCallGrounded,
        now: turnNow,
        timezone,
      });

      debug.llm_calls = buildRuntimeLlmCallDebug({ main_agent_called: true });
      const firstStep = await invokeRuntimeModelIteration({
        state: modelIteration,
        caller: deps.caller,
        model: deps.model,
        system_instruction: systemInstruction,
        message: input.user_message,
        context: composeRuntimeModelContext(callerContext, { booking_process_state: firstCallVisibleState }),
        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
      });
      modelIteration = firstStep.state;
      conversationId = modelIteration.conversation_id;
      if (firstStep.kind === "budget_exhausted") {
        debug.reason = "model_call_budget_exhausted_before_first_call";
        return {
          final_patient_reply: buildMalformedResponseFallback(input.locale),
          conversation_id: conversationId,
          conversation_id_resumable: false,
          tool_requests: [],
          tool_results: [],
          debug,
        };
      }
      if (firstStep.kind === "call_failed") {
        const error = firstStep.error;
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
          // Malformed/unparseable first response leaves OpenAI conversation in unknown state.
          // Mark dirty so orchestrator clears it rather than resuming on the next turn.
          conversation_id_resumable: false,
          tool_requests: [],
          tool_results: [],
          debug,
        };
      }

      const firstOutput = firstStep.output;

      if (firstOutput.type === "final_response" && isMalformedFinalResponse(firstOutput)) {
        debug.reason = "malformed_first_model_response";
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: buildMalformedResponseFallback(input.locale),
          conversation_id: conversationId,
          // Malformed output means OpenAI conversation state is unreliable — dirty it.
          conversation_id_resumable: false,
          tool_requests: [],
          tool_results: [],
          debug,
        };
      }

      if (firstOutput.type === "final_response") {
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        // Persist state on no-tool final_response: saves any state change this turn
        // (selected_slot, phone_trusted, next_action, etc.) not just slot detection.
        if (deps.bookingProcessStateRepository) {
          deps.bookingProcessStateRepository.saveState(
            { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
            bookingProcessState,
            (info) => { if (!info.saved) debug.booking_process_state_save = info; },
          ).catch(() => undefined);
        }
        return {
          final_patient_reply: firstOutput.final_response.final_patient_reply,
          conversation_id: conversationId,
          tool_requests: [],
          tool_results: [],
          debug,
          ui: maybeAttachPhoneRequestUI(firstCallVisibleState, firstOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
          ...(firstOutput.final_response.subject_intent != null ? { subject_intent: firstOutput.final_response.subject_intent } : {}),
          ...(firstOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: firstOutput.final_response.phone_ownership_intent } : {}),
        };
      }

      const toolRequests = firstOutput.tool_requests;
      // Accumulates all booking.apply requests seen this turn (round-1 + round-2),
      // so callers/orchestrators can see the full picture regardless of which round executed.
      const processedToolRequests: RuntimeAgentToolRequest[] = [...toolRequests];
      const toolResults: RuntimeAgentToolResult[] = [];

      // One booking write per turn — block all immediately if round-1 contains more than one.
      const allBookingApplyRound1 = toolRequests.filter((r) => r.tool === "booking.apply");
      if (allBookingApplyRound1.length > 1) {
        debug.reason = "booking_apply_preflight_multiple_booking_apply_round1";
        return await finalizeBlockedMultipleBookingApplies({
          pendingRequestsForRound: toolRequests,  // ALL round-1 requests must get results
          guardedData: {
            booking_status: "subject_resolution_conflict",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "clarify_subject",
            reason: "multiple_booking_apply_requests",
          },
          previousToolResults: [],
          toolRequests: processedToolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
          booking_subjects_after_resolution: null,
        });
      }

      // Debug: log tool call args for observability (date/time/service only; name/phone redacted).
      debug.tool_call_args = toolRequests.map((r) => {
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
            // first_name/last_name deliberately omitted — patient PII
          };
        }
        return { tool: r.tool };
      });

      // Global preflight C — availability past-time guard: if availability.check is
      // requested for today at a time that has already passed, return the past-time reply
      // directly.  Without this, the executor filters the slot (0 slots returned) and the
      // model replies "нет свободных слотов" instead of "this time has passed".
      // Only fires when requested_time is explicitly present — missing time means "show all
      // slots for the day", which the executor handles correctly via past-slot filtering.
      const availCheckRound1 = findLastAvailabilityRequest(toolRequests);
      if (availCheckRound1) {
        const availTime = typeof availCheckRound1.arguments.requested_time === "string"
          ? availCheckRound1.arguments.requested_time : undefined;
        if (availTime && isPastBookingTime({
          requestedDate: typeof availCheckRound1.arguments.requested_date === "string"
            ? availCheckRound1.arguments.requested_date : undefined,
          requestedTime: availTime,
          timezone,
          now: turnNow,
        })) {
          debug.past_time_detail = {
            requestedDate: typeof availCheckRound1.arguments.requested_date === "string" ? availCheckRound1.arguments.requested_date : undefined,
            requestedTime: availTime,
            timezone,
            nowISO: turnNow.toISOString(),
            todayInTimezone: getTodayInTimezone(turnNow, timezone),
          };
          debug.reason = "availability_preflight_past_time";
          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
          return {
            final_patient_reply: buildPastTimeReply(input.locale),
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: toolRequests,
            tool_results: [],
            debug,
          };
        }
      }

      const round1TurnBatch = await executeRuntimeTurnToolBatch({
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

      const bookingActionTruth = buildBookingApplyActionTruth(toolResults);
      // Resolve the authoritative availability attempt once; pass to all three consumers
      // so action truth, presentation truth, and booking state share the same pair.
      const authoritativeAvailabilityAttempt = resolveAuthoritativeAvailabilityAttempt(processedToolRequests, toolResults);
      const availabilityActionTruth = buildAvailabilityActionTruth(authoritativeAvailabilityAttempt);
      const availabilityPresentationTruth = buildAvailabilityPresentationTruth(authoritativeAvailabilityAttempt);
      const appointmentDisplayTruth = buildAppointmentDisplayTruth(toolResults);

      // Second call: grounded when prior state had meaningful booking data, OR
      // when the current turn produced booking-relevant evidence (availability.check /
      // booking.apply tool results, or selected_slot detected from offered slots).
      // Non-booking tools (knowledge.search, faq, etc.) do NOT make state grounded.
      const hasBookingToolResult = toolResults.some(
        (r) => r.tool === "availability.check" || r.tool === "booking.apply" || r.tool === "booking.select_slot",
      );
      const selectedSlotDetected = bookingProcessState.selected_slot != null;
      const secondCallGrounded =
        (priorProcessState !== null && hasMeaningfulBookingState(priorProcessState)) ||
        hasBookingToolResult ||
        selectedSlotDetected;
      const secondCallVisibleState = buildModelVisibleBookingProcessState({
        state: bookingProcessState,
        priorProcessState,
        bookingStateGrounded: secondCallGrounded,
        now: turnNow,
        timezone,
      });

      const secondCallContext = composeRuntimeModelContext(callerContext, {
        booking_apply_action_truth: bookingActionTruth,
        availability_action_truth: availabilityActionTruth,
        availability_presentation_truth: availabilityPresentationTruth,
        appointment_display_truth: appointmentDisplayTruth,
        booking_process_state: secondCallVisibleState,
      });

      // Ordinary first-batch booking guards are terminal decisions: after the runtime
      // has deterministically asked for phone/name/service/slot or rejected past time,
      // the next model step only needs to phrase the reply. Guard S is different: it
      // leaves round1GuardedData null so the model may legitimately retry booking.apply
      // after select_slot proof was persisted.
      const secondCallAllowsTools = round1GuardedData === null;

      const secondStep = await invokeRuntimeModelIteration({
        state: modelIteration,
        caller: deps.caller,
        model: deps.model,
        system_instruction: systemInstruction,
        message: input.user_message,
        context: secondCallContext,
        ...(secondCallAllowsTools ? { tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS } : {}),
        tool_results: toolResults,
      });
      modelIteration = secondStep.state;
      conversationId = modelIteration.conversation_id;
      if (secondStep.kind === "budget_exhausted") {
        debug.reason = "model_call_budget_exhausted_before_second_call";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: bookingActionTruth
            ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
            : buildMalformedResponseFallback(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
        };
      }
      if (secondStep.kind === "call_failed") {
        const error = secondStep.error;
        debug.runtime_error = {
          code: "agent_final_response_failed",
          message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        };
        const emergencyReply = bookingActionTruth
          ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
          : buildMalformedResponseFallback(input.locale);
        debug.reason = bookingActionTruth
          ? "agent_second_call_exception_booking_fallback"
          : "agent_second_call_exception_generic_fallback";
        debug.caller_exception = buildCallerExceptionDiagnostics(error, {
          stage: "second_call",
          locale: input.locale,
          conversationId,
          toolResults,
          bookingApplyActionTruth: bookingActionTruth,
        });
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: emergencyReply,
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
          // Preserve execution metadata so orchestrator can persist booking result even on exception
          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
        };
      }

      const secondOutput = secondStep.output;

      if (secondOutput.type === "final_response" && isMalformedFinalResponse(secondOutput)) {
        const malformedReply = bookingActionTruth
          ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
          : buildMalformedResponseFallback(input.locale);
        debug.reason = bookingActionTruth
          ? "malformed_second_model_response_booking_fallback"
          : "malformed_second_model_response_generic_fallback";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: malformedReply,
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
          // Preserve execution metadata even on malformed response
          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
        };
      }

      if (!secondCallAllowsTools && secondOutput.type === "tool_requests") {
        // Fail closed if a terminal model step violates the no-tools contract. The
        // deterministic booking guard remains the authoritative reason for the turn.
        debug.terminal_tool_request_ignored = true;
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        const channel = typeof input.business_context?.channel === "string"
          ? input.business_context.channel
          : undefined;
        return {
          final_patient_reply: buildBookingApplyEmergencyFallback(toolResults, input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: processedToolRequests,
          tool_results: toolResults,
          debug,
          ...(round1GuardedData?.required_next_action === "ask_for_phone"
            ? { ui: buildPhoneCaptureUi(channel) }
            : {}),
          ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
          ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
          ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
        };
      }

      if (secondOutput.type === "tool_requests") {
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

        const round2TurnBatch = await executeRuntimeTurnToolBatch({
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
        const boundedStep = await invokeRuntimeModelIteration({
          state: modelIteration,
          caller: deps.caller,
          model: deps.model,
          system_instruction: systemInstruction,
          message: input.user_message,
          context: composeRuntimeModelContext(callerContext, {
            booking_apply_action_truth: boundedBookingTruth,
            availability_action_truth: boundedAvailabilityTruth,
            availability_presentation_truth: boundedAvailabilityPresentation,
            appointment_display_truth: boundedAppointmentTruth,
            booking_process_state: boundedVisibleState,
          }),
          tool_results: resolvedRound2Results,
        });
        modelIteration = boundedStep.state;
        conversationId = modelIteration.conversation_id;

        const finalExecutionSubjectId = round2ExecutionSubjectId ?? round1ExecutionSubjectId;
        const finalBookingApplyResolution = round2BookingApplyResolution ?? round1BookingApplyResolution;

        if (boundedStep.kind === "budget_exhausted") {
          debug.reason = "bounded_tool_batch_budget_exhausted_before_final_call";
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

        if (boundedStep.kind === "call_failed") {
          const error = boundedStep.error;
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

        const boundedOutput = boundedStep.output;

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
        finalUi = forcePhoneCaptureUiForGuard(guardedData ?? round1GuardedData, finalUi, channel);

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

      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
      const secondFinalChannel = typeof input.business_context?.channel === "string"
        ? input.business_context.channel
        : undefined;
      let secondFinalUi = maybeAttachPhoneRequestUI(
        secondCallVisibleState,
        secondOutput.final_response.ui,
        secondFinalChannel,
      );
      secondFinalUi = forcePhoneCaptureUiForGuard(round1GuardedData, secondFinalUi, secondFinalChannel);
      return {
        final_patient_reply: secondOutput.final_response.final_patient_reply,
        conversation_id: conversationId,
        tool_requests: toolRequests,
        tool_results: toolResults,
        debug,
        ui: secondFinalUi,
        ...(secondOutput.final_response.subject_intent != null ? { subject_intent: secondOutput.final_response.subject_intent } : {}),
        ...(secondOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: secondOutput.final_response.phone_ownership_intent } : {}),
        // Propagate frozen execution subject so orchestrator can apply booking result to correct subject
        ...(round1ExecutionSubjectId != null ? { execution_subject_id: round1ExecutionSubjectId } : {}),
        ...(effectiveBookingSubjects != null ? { booking_subjects_after_resolution: effectiveBookingSubjects } : {}),
        ...(round1BookingApplyResolution != null ? { booking_apply_resolution: round1BookingApplyResolution } : {}),
      };
    },
  };
}

// ── Multiple-blocked booking.apply helper (Variant A) ────────────────────────

/**
 * When multiple booking.apply calls are present in the same round, create a
 * synthetic "blocked" result for EACH call_id and submit them all at once to
 * the model. This closes all pending function_calls cleanly so the conversation
 * stays resumable, and prevents any single call_id from being left dangling.
 */
export async function finalizeBlockedMultipleBookingApplies(params: {
  /** All pending requests from the current model response — every call_id must get a result. */
  pendingRequestsForRound: RuntimeAgentToolRequest[];
  guardedData: GuardedBookingApplyData;
  previousToolResults: RuntimeAgentToolResult[];
  toolRequests: RuntimeAgentToolRequest[];
  conversationId: string | null;
  systemInstruction: string;
  callerContext: Record<string, unknown>;
  input: RuntimeAgentTurnInput;
  debug: Record<string, unknown>;
  deps: CreateRuntimeAgentLoopDeps;
  booking_apply_resolution?: BookingApplyResolution | null;
  booking_subjects_after_resolution?: BookingSubjectsState | null;
}): Promise<RuntimeAgentTurnResult> {
  const {
    pendingRequestsForRound, guardedData, previousToolResults, toolRequests,
    conversationId, systemInstruction, callerContext, input, debug, deps,
    booking_apply_resolution, booking_subjects_after_resolution,
  } = params;

  // Create a result for each call_id — booking.apply gets the blocked data,
  // other tools get a denial explaining why they were not executed.
  const guardedResults: RuntimeAgentToolResult[] = pendingRequestsForRound.map((req) => {
    if (req.tool === "booking.apply") {
      return {
        tool: "booking.apply",
        call_id: req.call_id,
        status: "success" as const,
        data: guardedData,
      };
    }
    return {
      tool: req.tool,
      call_id: req.call_id,
      status: "denied" as const,
      error: {
        code: "turn_aborted_due_to_multiple_booking_requests",
        message: "Tool was not executed because multiple booking.apply requests were emitted.",
      },
    };
  });

  const allResults = [...previousToolResults, ...guardedResults];
  const bookingApplyTruth = buildBookingApplyActionTruth(allResults);

  const guardedCall = await invokeRuntimeModelCall({
    caller: deps.caller,
    model: deps.model,
    conversation_id: conversationId,
    system_instruction: systemInstruction,
    message: input.user_message,
    context: composeRuntimeModelContext(callerContext, {
      booking_apply_action_truth: bookingApplyTruth,
    }),
    tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    tool_results: guardedResults,
  });
  if (!guardedCall.ok) {
    const error = guardedCall.error;
    debug.runtime_error = {
      code: "guarded_multiple_booking_caller_failed",
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    };
    debug.finalization_reason = "guarded_multiple_booking_caller_exception";
    debug.caller_exception = buildCallerExceptionDiagnostics(error, {
      stage: "second_call",
      locale: input.locale,
      conversationId,
      toolResults: allResults,
      bookingApplyActionTruth: bookingApplyTruth,
    });
    markConversationDirty(debug);
    await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
    return {
      final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
      conversation_id: null,
      conversation_id_resumable: false,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
    };
  }

  const guardedOutput = guardedCall.output;
  const updatedConversationId = guardedCall.conversation_id;

  if (guardedOutput.type === "final_response" && !isMalformedFinalResponse(guardedOutput)) {
    await saveConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);
    return {
      final_patient_reply: guardedOutput.final_response.final_patient_reply,
      conversation_id: updatedConversationId,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ui: sanitizePhoneCaptureUiForChannel(guardedOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
      ...(guardedOutput.final_response.subject_intent != null ? { subject_intent: guardedOutput.final_response.subject_intent } : {}),
      ...(guardedOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: guardedOutput.final_response.phone_ownership_intent } : {}),
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
    };
  }

  debug.finalization_reason = guardedOutput.type === "tool_requests"
    ? "guarded_multiple_booking_second_call_still_tool_requests"
    : "guarded_multiple_booking_second_call_malformed";
  markConversationDirty(debug);
  await clearConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);
  return {
    final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
    conversation_id: null,
    conversation_id_resumable: false,
    tool_requests: toolRequests,
    tool_results: allResults,
    debug,
    ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
    ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
  };
}

// ── Guarded booking.apply helper ─────────────────────────────────────────────

export interface GuardedBookingApplyData {
  booking_status: string;
  created_visit: false;
  may_claim_booked: false;
  required_next_action: string;
  reason: string;
  missing_fields?: string[];
}

/**
 * When a booking.apply call is blocked by a deterministic preflight guard, this
 * helper submits a synthetic "guarded" tool_result for the pending call_id back
 * to the same OpenAI conversation instead of early-returning dirty.  The model
 * then produces a natural final_response (e.g. "please share your phone") while
 * conversation_id stays clean and resumable on the next patient turn.
 *
 * On failure of the second caller call the conversation IS marked dirty — the
 * pending function_call may be unresolved and the 400 risk is real.
 */
export async function finalizeBlockedBookingApplyWithToolOutput(params: {
  pendingBookingApply: RuntimeAgentToolRequest;
  guardedData: GuardedBookingApplyData;
  previousToolResults: RuntimeAgentToolResult[];
  toolRequests: RuntimeAgentToolRequest[];
  conversationId: string | null;
  systemInstruction: string;
  callerContext: Record<string, unknown>;
  input: RuntimeAgentTurnInput;
  debug: Record<string, unknown>;
  deps: CreateRuntimeAgentLoopDeps;
  execution_subject_id?: SubjectId | null;
  booking_subjects_after_resolution?: BookingSubjectsState | null;
  booking_apply_resolution?: BookingApplyResolution | null;
}): Promise<RuntimeAgentTurnResult> {
  const {
    pendingBookingApply, guardedData, previousToolResults, toolRequests,
    conversationId, systemInstruction, callerContext, input, debug, deps,
    execution_subject_id, booking_subjects_after_resolution, booking_apply_resolution,
  } = params;

  const guardedToolResult: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: pendingBookingApply.call_id,
    status: "success",
    data: guardedData,
  };

  const allResults = [...previousToolResults, guardedToolResult];
  const bookingApplyTruth = buildBookingApplyActionTruth(allResults);

  const guardedCall = await invokeRuntimeModelCall({
    caller: deps.caller,
    model: deps.model,
    conversation_id: conversationId,
    system_instruction: systemInstruction,
    message: input.user_message,
    context: composeRuntimeModelContext(callerContext, {
      booking_apply_action_truth: bookingApplyTruth,
    }),
    tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    tool_results: [guardedToolResult],
  });
  if (!guardedCall.ok) {
    const error = guardedCall.error;
    debug.runtime_error = {
      code: "guarded_booking_apply_caller_failed",
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    };
    debug.finalization_reason = "guarded_booking_apply_caller_exception";
    debug.caller_exception = buildCallerExceptionDiagnostics(error, {
      stage: "second_call",
      locale: input.locale,
      conversationId,
      toolResults: allResults,
      bookingApplyActionTruth: bookingApplyTruth,
    });
    markConversationDirty(debug);
    await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
    return {
      final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
      conversation_id: null,
      conversation_id_resumable: false,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ...(execution_subject_id != null ? { execution_subject_id } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
    };
  }

  const guardedOutput = guardedCall.output;
  const updatedConversationId = guardedCall.conversation_id;

  if (guardedOutput.type === "final_response" && !isMalformedFinalResponse(guardedOutput)) {
    await saveConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);

    // Sanitize model-emitted Telegram UI for non-Telegram channels before merging.
    const channel = typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined;
    let ui = sanitizePhoneCaptureUiForChannel(guardedOutput.final_response.ui, channel);
    // For phone guards, force the contact capture UI regardless of what the model returned —
    // the model may omit it, but the UI must always show it deterministically.
    if (guardedData.required_next_action === "ask_for_phone") {
      const captureUi = buildPhoneCaptureUi(channel);
      if (captureUi) {
        ui = { ...ui, ...captureUi, telegram: { ...(ui?.telegram ?? {}), ...(captureUi.telegram ?? {}) } };
      }
    }

    return {
      final_patient_reply: guardedOutput.final_response.final_patient_reply,
      conversation_id: updatedConversationId,
      tool_requests: toolRequests,
      tool_results: allResults,
      debug,
      ui,
      ...(guardedOutput.final_response.subject_intent != null ? { subject_intent: guardedOutput.final_response.subject_intent } : {}),
      ...(guardedOutput.final_response.phone_ownership_intent != null ? { phone_ownership_intent: guardedOutput.final_response.phone_ownership_intent } : {}),
      ...(execution_subject_id != null ? { execution_subject_id } : {}),
      ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
      ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
    };
  }

  // Second caller returned further tool_requests or a malformed response — cannot
  // resolve cleanly.  Mark dirty so the conversation is not resumed with a pending call.
  debug.finalization_reason = guardedOutput.type === "tool_requests"
    ? "guarded_booking_apply_second_call_still_tool_requests"
    : "guarded_booking_apply_second_call_malformed";
  markConversationDirty(debug);
  await clearConversationMemory(deps.conversationMemoryRepository, input, updatedConversationId, debug);
  return {
    final_patient_reply: buildBookingApplyEmergencyFallback(allResults, input.locale),
    conversation_id: null,
    conversation_id_resumable: false,
    tool_requests: toolRequests,
    tool_results: allResults,
    debug,
    ...(execution_subject_id != null ? { execution_subject_id } : {}),
    ...(booking_subjects_after_resolution != null ? { booking_subjects_after_resolution } : {}),
    ...(booking_apply_resolution != null ? { booking_apply_resolution } : {}),
  };
}

// Returns true when at least one tool result has status=success with non-empty
// payload data. Empty chunks/slots are excluded — they provide no answer for
// the model to synthesize, so the generic fallback is still appropriate.
export function hasUsefulToolResults(results: RuntimeAgentToolResult[]): boolean {
  return results.some((r) => {
    if (r.status !== "success") return false;
    const data = r.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== "object") return false;
    if ("chunks" in data && Array.isArray(data.chunks)) return data.chunks.length > 0;
    if ("slots" in data && Array.isArray(data.slots)) return data.slots.length > 0;
    return true;
  });
}

/** True when the caller returned a well-formed-looking final_response that is actually
 * a synthesized placeholder for output normalizeOpenAIResponse could not parse. */
export function isMalformedFinalResponse(output: RuntimeAgentCallerOutput): boolean {
  return (
    output.type === "final_response" &&
    Array.isArray(output.final_response.safety_notes) &&
    output.final_response.safety_notes.includes("malformed_openai_response")
  );
}

export function buildMalformedResponseFallback(locale?: string | null): string {
  const normalized = String(locale ?? "").toLowerCase();
  if (normalized.startsWith("cs")) {
    return "Teď se nepodařilo zprávu správně zpracovat. Zkuste to prosím znovu nebo kontaktujte kliniku přímo.";
  }
  if (normalized.startsWith("en")) {
    return "Sorry, I’m having trouble processing that right now. Please try again in a moment.";
  }
  return "Сейчас не получилось корректно обработать сообщение. Попробуйте, пожалуйста, ещё раз или свяжитесь с клиникой напрямую.";
}

export function buildMultiRoundFallbackReply(locale?: string | null): string {
  const normalized = String(locale ?? "").toLowerCase();
  if (normalized.startsWith("en")) {
    return "I'll clarify the details with the clinic team — one moment.";
  }
  if (normalized.startsWith("cs")) {
    return "Ověřím podrobnosti s týmem kliniky — chvilku prosím.";
  }
  return "Уточню детали с командой клиники — один момент.";
}

/**
 * Deterministically attaches the channel-appropriate contact capture UI when
 * booking_process_state.next_action === "ask_for_phone" and phone is not yet trusted.
 * Applied to all final_response return paths so the button appears even when the
 * model skips booking.apply and returns a plain text response asking for contact.
 * Preserves any existing ui fields; does not overwrite an already-set request_contact.
 */
function forcePhoneCaptureUiForGuard(
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

export function maybeAttachPhoneRequestUI(
  bookingProcessState: ModelVisibleBookingProcessState | BookingProcessState | null,
  existingUi: AgentUiActions | undefined,
  channel?: string | null,
): AgentUiActions | undefined {
  // Always sanitize model-emitted Telegram contact UI for channels that don't permit it.
  let sanitized = sanitizePhoneCaptureUiForChannel(existingUi, channel);

  // If phone is already trusted, also strip any model-emitted contact request — we should
  // never ask the patient to share a phone we already have.
  if (bookingProcessState?.phone_trusted === true && sanitized?.telegram?.request_contact) {
    const { request_contact: _rc, button_text: _bt, ...restTelegram } = sanitized.telegram;
    const hasRemainingTelegram = Object.keys(restTelegram).length > 0;
    const { telegram: _tg, ...restUi } = sanitized;
    sanitized = hasRemainingTelegram
      ? { ...restUi, telegram: restTelegram }
      : Object.keys(restUi).length > 0 ? restUi : undefined;
  }

  // Only attach contact button when confidence is high (or not set, for compatibility with
  // the guarded booking.apply path which passes raw BookingProcessState).
  // Low-confidence state means next_action was derived from defaults without durable backing —
  // in that case we do not force a UI that may be wrong.
  const confidence = (bookingProcessState as ModelVisibleBookingProcessState)?.next_action_confidence;
  if (confidence === "low") return sanitized;

  if (
    bookingProcessState?.next_action === "ask_for_phone" &&
    bookingProcessState?.phone_trusted !== true
  ) {
    if (sanitized?.telegram?.request_contact) return sanitized;
    const captureUi = buildPhoneCaptureUi(channel);
    if (!captureUi) return sanitized;
    return {
      ...sanitized,
      ...captureUi,
      telegram: { ...(sanitized?.telegram ?? {}), ...(captureUi.telegram ?? {}) },
    };
  }
  return sanitized;
}

/** Marks debug so callers/logs can see the OpenAI conversation_id for this turn
 * must not be persisted/resumed — it has a pending function_call with no
 * function_call_output submitted (see forced-finalization branches above). */
function markConversationDirty(debug: Record<string, unknown>): void {
  debug.openai_conversation_resumable = false;
  debug.conversation_id_reset_reason = "pending_tool_call_after_forced_finalization";
}

async function saveConversationMemory(
  repository: ConversationMemoryRepository | undefined,
  input: RuntimeAgentTurnInput,
  conversationId: string | null,
  debug: Record<string, unknown>,
): Promise<void> {
  if (!repository || !conversationId) {
    return;
  }
  try {
    const saveResult = await repository.saveConversationMemory({
      clinic_id: input.clinic_id,
      contact_id: input.contact_id,
      case_id: input.case_id,
      conversation_id: conversationId,
    });
    debug.memory_saved = saveResult.ok;
    if (!saveResult.ok) {
      debug.memory_save_error = saveResult.error;
    }
  } catch (error) {
    debug.memory_saved = false;
    debug.memory_save_error = error instanceof Error ? error.message : String(error);
  }
}

/** Explicitly clears agent-level conversation memory when a conversation just went dirty
 * (see markConversationDirty). saveConversationMemory() alone won't do this — its early
 * return on a falsy conversationId means passing null there is a silent no-op, leaving any
 * previously stored value in place to be resumed (and fail with the same upstream 400) on
 * the next turn. No-ops when there was nothing to clear (dirtyConversationId was already null). */
async function clearConversationMemory(
  repository: ConversationMemoryRepository | undefined,
  input: RuntimeAgentTurnInput,
  dirtyConversationId: string | null,
  debug: Record<string, unknown>,
): Promise<void> {
  if (!repository || !dirtyConversationId) {
    return;
  }
  try {
    const saveResult = await repository.saveConversationMemory({
      clinic_id: input.clinic_id,
      contact_id: input.contact_id,
      case_id: input.case_id,
      conversation_id: "",
    });
    debug.memory_cleared = saveResult.ok;
    if (!saveResult.ok) {
      debug.memory_save_error = saveResult.error;
    }
  } catch (error) {
    debug.memory_cleared = false;
    debug.memory_save_error = error instanceof Error ? error.message : String(error);
  }
}

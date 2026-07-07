import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  buildRuntimeAgentSystemInstruction,
  type AgentUiActions,
  type OpenAIRuntimeAgent,
  type RuntimeAgentFinalResponse,
  type RuntimeAgentToolRequest,
  type RuntimeAgentToolResult,
  type RuntimeAgentTurnInput,
  type RuntimeAgentTurnResult,
} from "./openaiRuntimeAgent.ts";
import { applyToolPolicy, type PlannerOutput, type ToolName, type TruthSnapshot } from "./toolPolicy.ts";
import { executeAllowedTools, type ToolExecutorRegistry, type ToolExecutionContext } from "./toolExecutor.ts";
import { buildTruthSnapshot } from "./truthSnapshot.ts";
import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";
import type { ToolExecutionResult } from "./toolResults.ts";
import { buildModelVisibleCallerContext } from "./modelVisibleCallerContext.ts";
import { buildRuntimeLlmCallDebug } from "./llmCallDebug.ts";
import { buildBookingApplyActionTruth, buildBookingApplyEmergencyFallback } from "./bookingApplyGuard.ts";
import { buildCallerExceptionDiagnostics, sanitizeErrorMessage } from "./callerExceptionDiagnostics.ts";
import { hasTrustedPhone } from "./bookingContactGuard.ts";
import { shouldInterceptMissingPhoneBeforeBookingApply, shouldInterceptNoSlotsBeforeBookingApply, bookingApplyArgsMissingSlot, getMissingBookingApplyNameFields, bookingApplyArgsMissingService, shouldInterceptInvalidSlotTime } from "./bookingApplyPreflight.ts";
import { isPastBookingTime, buildPastTimeReply } from "./bookingPreflight.ts";
import { buildAvailabilityPresentationTruth } from "./availabilityPresentationTruth.ts";
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

export interface RuntimeAgentCallerInput {
  model: string;
  conversation_id?: string | null;
  system_instruction: string;
  input: {
    message: string;
    context: Record<string, unknown>;
    tool_definitions?: typeof RUNTIME_AGENT_TOOL_DEFINITIONS;
    tool_results?: RuntimeAgentToolResult[];
  };
}

export type RuntimeAgentCallerOutput =
  | {
    type: "tool_requests";
    conversation_id?: string | null;
    tool_requests: RuntimeAgentToolRequest[];
    usage?: unknown;
  }
  | {
    type: "final_response";
    conversation_id?: string | null;
    final_response: RuntimeAgentFinalResponse;
    usage?: unknown;
  };

export type RuntimeAgentCaller = (input: RuntimeAgentCallerInput) => Promise<RuntimeAgentCallerOutput>;

export interface CreateRuntimeAgentLoopDeps {
  model: string;
  caller: RuntimeAgentCaller;
  executors: ToolExecutorRegistry;
  conversationMemoryRepository?: ConversationMemoryRepository;
  bookingProcessStateRepository?: BookingProcessStateRepository;
  now?: Date;
  timezone?: string;
}

const ACTIVE_TOOL_SET = new Set<string>(ACTIVE_RUNTIME_AGENT_TOOLS);

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

      // Initial state derived from prior + patient message (no tool results yet this turn)
      let bookingProcessState = computeBookingProcessState({
        prior: priorProcessState,
        patientMessage: input.user_message,
        channelContact: input.channel_contact,
      });

      // First call: grounded only if prior state has meaningful booking data.
      // Non-booking tool results and empty prior state do NOT make it grounded.
      const firstCallGrounded =
        priorProcessState !== null && hasMeaningfulBookingState(priorProcessState);
      const firstCallVisibleState = buildModelVisibleBookingProcessState({
        state: bookingProcessState,
        priorProcessState,
        bookingStateGrounded: firstCallGrounded,
      });

      let firstOutput: RuntimeAgentCallerOutput;
      try {
        debug.llm_calls = buildRuntimeLlmCallDebug({ main_agent_called: true });
        firstOutput = await deps.caller({
          model: deps.model,
          conversation_id: conversationId,
          system_instruction: systemInstruction,
          input: {
            message: input.user_message,
            context: { ...callerContext, booking_process_state: firstCallVisibleState },
            tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
          },
        });
      } catch (error) {
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

      if (firstOutput.conversation_id !== undefined) {
        conversationId = firstOutput.conversation_id;
      }

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
        };
      }

      const toolRequests = firstOutput.tool_requests;
      const toolResults: RuntimeAgentToolResult[] = [];

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
      const availCheckRound1 = toolRequests.find((r) => r.tool === "availability.check");
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

      // Global preflight A — past-time guard: if booking.apply is requested for a
      // same-day slot that has already passed, reject before executing any tool.
      // Applies to round 1 (booking.apply as the first tool of a turn).
      const bookingApplyRound1 = toolRequests.find((r) => r.tool === "booking.apply");
      if (bookingApplyRound1) {
        if (isPastBookingTime({
          requestedDate: typeof bookingApplyRound1.arguments.requested_date === "string"
            ? bookingApplyRound1.arguments.requested_date : undefined,
          requestedTime: typeof bookingApplyRound1.arguments.requested_time === "string"
            ? bookingApplyRound1.arguments.requested_time : undefined,
          timezone,
          now: turnNow,
        })) {
          debug.reason = "booking_apply_preflight_past_time_round1";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: bookingApplyRound1,
            guardedData: {
              booking_status: "past_time",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_alternative_time",
              reason: "requested_time_is_in_past",
            },
            previousToolResults: [],
            toolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
          });
        }
      }

      // Global preflight B — phone guard: if booking.apply is requested in round 1
      // and no trusted phone is present, submit a guarded tool_result so the model
      // can ask for the patient's phone while keeping conversation_id clean.
      if (bookingApplyRound1 && !hasTrustedPhone(input.channel_contact)) {
        debug.reason = "booking_apply_preflight_missing_trusted_phone_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "missing_trusted_phone",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_phone",
            reason: "trusted_phone_required",
          },
          previousToolResults: [],
          toolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
        });
      }

      // Global preflight D — no-slot guard (round 1): trusted phone is present but
      // booking.apply args don't include a concrete date+time.  Submit a guarded
      // tool_result so the model can ask the patient to choose a slot.
      if (bookingApplyRound1 && hasTrustedPhone(input.channel_contact) && bookingApplyArgsMissingSlot(bookingApplyRound1.arguments)) {
        debug.reason = "booking_apply_preflight_missing_slot_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "missing_slot",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_slot",
            reason: "requested_date_time_required",
          },
          previousToolResults: [],
          toolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
        });
      }

      // Global preflight E — name-missing guard (round 1): trusted phone and slot are
      // present but first_name or last_name is absent from booking.apply args.  Submit
      // a guarded tool_result so the model asks only for the specific missing field.
      if (bookingApplyRound1 && hasTrustedPhone(input.channel_contact)) {
        const missingNames = getMissingBookingApplyNameFields(bookingApplyRound1.arguments);
        if (missingNames.length > 0) {
          debug.reason = "booking_apply_preflight_missing_name_round1";
          debug.missing_fields = missingNames;
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: bookingApplyRound1,
            guardedData: {
              booking_status: "missing_patient_name",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_name",
              reason: "patient_name_required",
              missing_fields: missingNames,
            },
            previousToolResults: [],
            toolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
          });
        }
      }

      // Global preflight F — service-missing guard (round 1): name and slot present but
      // neither service nor service_reason is specified.  Submit a guarded tool_result
      // so the model asks for the service reason.
      if (bookingApplyRound1 && hasTrustedPhone(input.channel_contact) && bookingApplyArgsMissingService(bookingApplyRound1.arguments)) {
        debug.reason = "booking_apply_preflight_missing_service_round1";
        return await finalizeBlockedBookingApplyWithToolOutput({
          pendingBookingApply: bookingApplyRound1,
          guardedData: {
            booking_status: "missing_service",
            created_visit: false,
            may_claim_booked: false,
            required_next_action: "ask_for_service",
            reason: "service_required",
          },
          previousToolResults: [],
          toolRequests,
          conversationId,
          systemInstruction,
          callerContext,
          input,
          debug,
          deps,
        });
      }

      for (const request of toolRequests) {
        if (!ACTIVE_TOOL_SET.has(request.tool)) {
          toolResults.push({
            tool: request.tool,
            call_id: request.call_id,
            status: "denied",
            error: { code: "tool_not_active", message: `${request.tool} is not active` },
          });
          continue;
        }

        const planner = buildPlannerFromAgentToolRequest(request);
        const truth = resolveTruthSnapshot(input, request, planner, turnNow);
        const policy = applyToolPolicy(planner, truth);
        if (policy.tools_denied.length > 0 || policy.tools_allowed.length === 0) {
          const denial = policy.tools_denied[0];
          toolResults.push({
            tool: request.tool,
            call_id: request.call_id,
            status: "denied",
            error: {
              code: denial?.reason ?? "policy_denied",
              message: `Tool denied by policy: ${denial?.reason ?? "unknown"}`,
            },
          });
          continue;
        }

        const executionContext = buildExecutionContext(input, request, planner, truth, turnNow);
        const executionResults = await executeAllowedTools({
          tools_allowed: policy.tools_allowed,
          registry: deps.executors,
          context: executionContext,
        });
        const execResult = executionResults[0];
        if (execResult?.tool === "availability.check" && execResult.status === "success" && execResult._diagnostic !== undefined) {
          debug.availability_diagnostic = execResult._diagnostic;
        }
        toolResults.push(convertToolExecutionResult(request, execResult));
      }

      const bookingActionTruth = buildBookingApplyActionTruth(toolResults);
      const availabilityPresentationTruth = buildAvailabilityPresentationTruth(toolResults);
      const appointmentDisplayTruth = buildAppointmentDisplayTruth(toolResults);

      // Update booking process state with tool results from this round (e.g. newly returned slots).
      bookingProcessState = computeBookingProcessState({
        prior: priorProcessState,
        toolResults,
        patientMessage: input.user_message,
        channelContact: input.channel_contact,
      });
      // Persist updated state (best-effort — non-blocking).
      if (deps.bookingProcessStateRepository) {
        deps.bookingProcessStateRepository.saveState(
          { clinic_id: input.clinic_id, contact_id: input.contact_id, case_id: input.case_id },
          bookingProcessState,
          (info) => { if (!info.saved) debug.booking_process_state_save = info; },
        ).catch(() => undefined);
      }

      // Second call: grounded when prior state had meaningful booking data, OR
      // when the current turn produced booking-relevant evidence (availability.check /
      // booking.apply tool results, or selected_slot detected from offered slots).
      // Non-booking tools (knowledge.search, faq, etc.) do NOT make state grounded.
      const hasBookingToolResult = toolResults.some(
        (r) => r.tool === "availability.check" || r.tool === "booking.apply",
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
      });

      const secondCallContext = {
        ...callerContext,
        ...(bookingActionTruth ? { booking_apply_action_truth: bookingActionTruth } : {}),
        ...(availabilityPresentationTruth ? { availability_presentation_truth: availabilityPresentationTruth } : {}),
        ...(appointmentDisplayTruth ? { appointment_display_truth: appointmentDisplayTruth } : {}),
        booking_process_state: secondCallVisibleState,
      };

      let secondOutput: RuntimeAgentCallerOutput;
      try {
        secondOutput = await deps.caller({
          model: deps.model,
          conversation_id: conversationId,
          system_instruction: systemInstruction,
          input: {
            message: input.user_message,
            context: secondCallContext,
            tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
            tool_results: toolResults,
          },
        });
      } catch (error) {
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
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: emergencyReply,
          conversation_id: conversationId,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
        };
      }

      if (secondOutput.conversation_id !== undefined) {
        conversationId = secondOutput.conversation_id;
      }

      if (secondOutput.type === "final_response" && isMalformedFinalResponse(secondOutput)) {
        const malformedReply = bookingActionTruth
          ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
          : buildMalformedResponseFallback(input.locale);
        debug.reason = bookingActionTruth
          ? "malformed_second_model_response_booking_fallback"
          : "malformed_second_model_response_generic_fallback";
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: malformedReply,
          conversation_id: conversationId,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
        };
      }

      if (secondOutput.type === "tool_requests") {
        // No-slots gate (round 2, first): availability.check returned 0 slots — no slot
        // exists to confirm regardless of phone status, so intercept before asking for phone.
        if (shouldInterceptNoSlotsBeforeBookingApply({
          pendingToolRequests: secondOutput.tool_requests,
          completedToolResults: toolResults,
        })) {
          const noSlotsPendingApply = secondOutput.tool_requests.find((r) => r.tool === "booking.apply")!;
          debug.reason = "booking_apply_preflight_no_slots";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: noSlotsPendingApply,
            guardedData: {
              booking_status: "no_available_slots",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_alternative_time",
              reason: "availability_check_returned_no_slots",
            },
            previousToolResults: toolResults,
            toolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
          });
        }

        // Guard A: booking.apply requested in round-2 but trusted phone absent — submit
        // a guarded tool_result so the model asks for the contact while conversation_id
        // stays clean.  Runs after the no-slots gate so we don't ask for a phone when
        // there are no slots to book anyway.
        if (shouldInterceptMissingPhoneBeforeBookingApply({
          pendingToolRequests: secondOutput.tool_requests,
          channelContact: input.channel_contact,
        })) {
          const missingPhonePendingApply = secondOutput.tool_requests.find((r) => r.tool === "booking.apply")!;
          debug.reason = "booking_apply_intercepted_missing_trusted_phone";
          return await finalizeBlockedBookingApplyWithToolOutput({
            pendingBookingApply: missingPhonePendingApply,
            guardedData: {
              booking_status: "missing_trusted_phone",
              created_visit: false,
              may_claim_booked: false,
              required_next_action: "ask_for_phone",
              reason: "trusted_phone_required",
            },
            previousToolResults: toolResults,
            toolRequests,
            conversationId,
            systemInstruction,
            callerContext,
            input,
            debug,
            deps,
          });
        }

        // Guard B: round-2 requested booking.apply and trusted phone is present.
        // Execute the pending booking.apply through the normal policy/executor path
        // so the model receives the actual booking result (visit_created / write_failed)
        // before producing a patient-facing reply.  Bypassing this and going straight to
        // forced_finalization would let the model hallucinate a confirmation without any
        // booking.apply execution, violating the invariant that may_claim_booked requires
        // a booking_status=visit_created proof.
        const pendingBookingApply = secondOutput.tool_requests.find((r) => r.tool === "booking.apply");
        if (pendingBookingApply && hasTrustedPhone(input.channel_contact)) {
          // Past-time preflight for Guard B: submit guarded tool_result if slot has passed.
          if (isPastBookingTime({
              requestedDate: typeof pendingBookingApply.arguments.requested_date === "string"
                ? pendingBookingApply.arguments.requested_date : undefined,
              requestedTime: typeof pendingBookingApply.arguments.requested_time === "string"
                ? pendingBookingApply.arguments.requested_time : undefined,
              timezone,
              now: turnNow,
            })) {
              debug.reason = "booking_apply_preflight_past_time_round2";
              return await finalizeBlockedBookingApplyWithToolOutput({
                pendingBookingApply,
                guardedData: {
                  booking_status: "past_time",
                  created_visit: false,
                  may_claim_booked: false,
                  required_next_action: "ask_for_alternative_time",
                  reason: "requested_time_is_in_past",
                },
                previousToolResults: toolResults,
                toolRequests,
                conversationId,
                systemInstruction,
                callerContext,
                input,
                debug,
                deps,
              });
          }

          // Guard D (round 2): no concrete date+time in args — submit guarded tool_result.
          if (bookingApplyArgsMissingSlot(pendingBookingApply.arguments)) {
            debug.reason = "booking_apply_preflight_missing_slot_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "missing_slot",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_slot",
                reason: "requested_date_time_required",
              },
              previousToolResults: toolResults,
              toolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
            });
          }

          // Guard E (round 2): slot present but first_name or last_name absent — submit guarded tool_result.
          const round2MissingNames = getMissingBookingApplyNameFields(pendingBookingApply.arguments);
          if (round2MissingNames.length > 0) {
            debug.reason = "booking_apply_preflight_missing_name_round2";
            debug.missing_fields = round2MissingNames;
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "missing_patient_name",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_name",
                reason: "patient_name_required",
                missing_fields: round2MissingNames,
              },
              previousToolResults: toolResults,
              toolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
            });
          }

          // Guard F (round 2): name and slot present but service/service_reason absent — submit guarded tool_result.
          if (bookingApplyArgsMissingService(pendingBookingApply.arguments)) {
            debug.reason = "booking_apply_preflight_missing_service_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "missing_service",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "ask_for_service",
                reason: "service_required",
              },
              previousToolResults: toolResults,
              toolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
            });
          }

          // Slot validity check (round 2): requested_time must match a slot returned by
          // availability.check.  Guards D and no-slots handle missing date/time and 0-slot
          // cases respectively, so by here date+time are present and ≥1 slot exists.
          if (shouldInterceptInvalidSlotTime({
            pendingToolRequests: secondOutput.tool_requests,
            completedToolResults: toolResults,
          })) {
            debug.reason = "booking_apply_preflight_invalid_slot_round2";
            return await finalizeBlockedBookingApplyWithToolOutput({
              pendingBookingApply,
              guardedData: {
                booking_status: "invalid_slot",
                created_visit: false,
                may_claim_booked: false,
                required_next_action: "choose_from_available_slots",
                reason: "requested_time_not_in_available_slots",
              },
              previousToolResults: toolResults,
              toolRequests,
              conversationId,
              systemInstruction,
              callerContext,
              input,
              debug,
              deps,
            });
          }

          debug.reason = "booking_apply_executed_after_round2_request";
          const bPlanner = buildPlannerFromAgentToolRequest(pendingBookingApply);
          const bTruth = resolveTruthSnapshot(input, pendingBookingApply, bPlanner, turnNow);
          const bPolicy = applyToolPolicy(bPlanner, bTruth);

          let bookingToolResult: RuntimeAgentToolResult;
          if (bPolicy.tools_denied.length > 0 || bPolicy.tools_allowed.length === 0) {
            const denial = bPolicy.tools_denied[0];
            bookingToolResult = {
              tool: "booking.apply",
              call_id: pendingBookingApply.call_id,
              status: "denied",
              error: {
                code: denial?.reason ?? "policy_denied",
                message: `Tool denied by policy: ${denial?.reason ?? "unknown"}`,
              },
            };
          } else {
            const bExecCtx = buildExecutionContext(input, pendingBookingApply, bPlanner, bTruth, turnNow);
            const bExecResults = await executeAllowedTools({
              tools_allowed: bPolicy.tools_allowed,
              registry: deps.executors,
              context: bExecCtx,
            });
            bookingToolResult = convertToolExecutionResult(pendingBookingApply, bExecResults[0]);
          }

          const allResults = [...toolResults, bookingToolResult];
          const bookingApplyTruth = buildBookingApplyActionTruth(allResults);
          const bookingApplyDisplayTruth = buildAppointmentDisplayTruth(allResults);

          markConversationDirty(debug);
          await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);

          let bookingFinalOutput: RuntimeAgentCallerOutput | undefined;
          try {
            bookingFinalOutput = await deps.caller({
              model: deps.model,
              conversation_id: null,
              system_instruction: systemInstruction,
              input: {
                message: input.user_message,
                context: {
                  ...callerContext,
                  resolved_context: allResults,
                  ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
                  ...(bookingApplyDisplayTruth ? { appointment_display_truth: bookingApplyDisplayTruth } : {}),
                },
              },
            });
          } catch (error) {
            debug.caller_exception = buildCallerExceptionDiagnostics(error, {
              stage: "forced_finalization",
              locale: input.locale,
              conversationId: null,
              toolResults: allResults,
              bookingApplyActionTruth: bookingApplyTruth,
            });
          }

          if (bookingFinalOutput !== undefined && bookingFinalOutput.type === "final_response" && !isMalformedFinalResponse(bookingFinalOutput)) {
            return {
              final_patient_reply: bookingFinalOutput.final_response.final_patient_reply,
              conversation_id: null,
              conversation_id_resumable: false,
              tool_requests: toolRequests,
              tool_results: allResults,
              debug,
              ui: sanitizePhoneCaptureUiForChannel(bookingFinalOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
            };
          }

          const bFallback = bookingApplyTruth
            ? buildBookingApplyEmergencyFallback(allResults, input.locale)
            : buildMultiRoundFallbackReply(input.locale);
          return {
            final_patient_reply: bFallback,
            conversation_id: null,
            conversation_id_resumable: false,
            tool_requests: toolRequests,
            tool_results: allResults,
            debug,
          };
        }

        // When round 2 requests more tools but useful results from round 1 exist,
        // attempt one forced finalization call (round 3). Protocol rules:
        // - conversation_id is null: fresh context so we don't continue a thread
        //   that has round-2 tool calls pending (which we cannot resolve here).
        // - No tool_results: avoids sending function_call_output for round-1 call_ids
        //   into a conversation whose last model turn requested different call_ids.
        // - Tool results are embedded as resolved_context in plain JSON — readable by
        //   the model without requiring tool-call protocol mechanics.
        // - No tool_definitions: model cannot request tools and must produce final_response.
        // Bounded: max 3 LLM calls total. Does not implement a recursive loop.
        if (hasUsefulToolResults(toolResults)) {
          let forcedOutput: RuntimeAgentCallerOutput | undefined;
          try {
            forcedOutput = await deps.caller({
              model: deps.model,
              conversation_id: null,
              system_instruction: systemInstruction,
              input: {
                message: input.user_message,
                context: {
                  ...callerContext,
                  resolved_context: toolResults,
                  ...(bookingActionTruth ? { booking_apply_action_truth: bookingActionTruth } : {}),
                  ...(appointmentDisplayTruth ? { appointment_display_truth: appointmentDisplayTruth } : {}),
                },
                // No tool_definitions → caller sends tools:[] → model must produce final_response.
                // No tool_results → no function_call_output protocol messages.
              },
            });
          } catch (error) {
            // Forced finalization failed — fall through to locale-aware fallback.
            debug.caller_exception = buildCallerExceptionDiagnostics(error, {
              stage: "forced_finalization",
              locale: input.locale,
              conversationId,
              toolResults,
              bookingApplyActionTruth: bookingActionTruth,
            });
          }
          if (forcedOutput !== undefined && forcedOutput.type === "final_response" && isMalformedFinalResponse(forcedOutput)) {
            debug.reason = "malformed_forced_finalization_fallback";
            const malformedForcedReply = bookingActionTruth
              ? buildBookingApplyEmergencyFallback(toolResults, input.locale)
              : buildMultiRoundFallbackReply(input.locale);
            markConversationDirty(debug);
            await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: malformedForcedReply,
              conversation_id: null,
              conversation_id_resumable: false,
              tool_requests: toolRequests,
              tool_results: toolResults,
              debug,
            };
          }
          if (forcedOutput !== undefined && forcedOutput.type === "final_response") {
            // secondOutput.type === "tool_requests" means round 2's own model response
            // requested a further tool call — that call was never resolved (forced
            // finalization deliberately used an unrelated, throwaway conversation to
            // produce the reply). conversationId therefore still has a pending
            // function_call with no function_call_output on OpenAI's side. Resuming it
            // on a later turn fails with 400 "No tool output found for function call ...".
            // Do not persist/resume it — start clean next turn instead.
            debug.reason = "forced_finalization_after_tool_results";
            markConversationDirty(debug);
            await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: forcedOutput.final_response.final_patient_reply,
              conversation_id: null,
              conversation_id_resumable: false,
              tool_requests: toolRequests,
              tool_results: toolResults,
              debug,
              ui: sanitizePhoneCaptureUiForChannel(forcedOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
            };
          }
        }

        debug.reason = "multi_round_tool_loop_not_implemented";
        markConversationDirty(debug);
        await clearConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: buildMultiRoundFallbackReply(input.locale),
          conversation_id: null,
          conversation_id_resumable: false,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
        };
      }

      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
      return {
        final_patient_reply: secondOutput.final_response.final_patient_reply,
        conversation_id: conversationId,
        tool_requests: toolRequests,
        tool_results: toolResults,
        debug,
        ui: maybeAttachPhoneRequestUI(secondCallVisibleState, secondOutput.final_response.ui, typeof input.business_context?.channel === "string" ? input.business_context.channel : undefined),
      };
    },
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
}): Promise<RuntimeAgentTurnResult> {
  const {
    pendingBookingApply, guardedData, previousToolResults, toolRequests,
    conversationId, systemInstruction, callerContext, input, debug, deps,
  } = params;

  const guardedToolResult: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: pendingBookingApply.call_id,
    status: "success",
    data: guardedData,
  };

  const allResults = [...previousToolResults, guardedToolResult];
  const bookingApplyTruth = buildBookingApplyActionTruth(allResults);

  let guardedOutput: RuntimeAgentCallerOutput;
  try {
    guardedOutput = await deps.caller({
      model: deps.model,
      conversation_id: conversationId,
      system_instruction: systemInstruction,
      input: {
        message: input.user_message,
        context: {
          ...callerContext,
          ...(bookingApplyTruth ? { booking_apply_action_truth: bookingApplyTruth } : {}),
        },
        tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
        tool_results: [guardedToolResult],
      },
    });
  } catch (error) {
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
    };
  }

  let updatedConversationId = conversationId;
  if (guardedOutput.conversation_id !== undefined) {
    updatedConversationId = guardedOutput.conversation_id;
  }

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

function buildPlannerFromAgentToolRequest(request: RuntimeAgentToolRequest): PlannerOutput {
  if (request.tool === "availability.check") {
    return {
      confidence: "high",
      tools_requested: ["availability.check"],
      reply_strategy: "answer_only",
      turn_type: "availability_request",
      booking_action: "check_availability",
    };
  }

  if (request.tool === "booking.apply") {
    return {
      confidence: "high",
      tools_requested: ["booking.apply"],
      reply_strategy: "answer_only",
      turn_type: "booking",
      booking_action: "confirm",
      explicit_patient_confirmation: true,
      booking_request: {
        service: typeof request.arguments.service === "string" ? request.arguments.service : null,
        preferred_date_text: typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : null,
        preferred_time_text: typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null,
      },
    };
  }

  return {
    confidence: "high",
    tools_requested: ["kb.search"],
    reply_strategy: "answer_only",
    turn_type: "faq",
    booking_action: null,
  };
}

function resolveTruthSnapshot(
  input: RuntimeAgentTurnInput,
  request: RuntimeAgentToolRequest,
  planner: PlannerOutput,
  now?: Date,
): TruthSnapshot {
  const provided = input.truth_snapshot;
  if (provided && typeof provided === "object") {
    const typed = provided as Partial<TruthSnapshot>;
    if (typeof typed.scheduling_intent_present === "boolean" && typeof typed.date_or_time_present === "boolean") {
      return typed as TruthSnapshot;
    }
  }

  return buildTruthSnapshot({
    planner,
    now,
    current_turn_flags: {
      scheduling_intent_present: request.tool === "availability.check" || request.tool === "booking.apply",
      date_or_time_present: typeof request.arguments.requested_date === "string"
        || typeof request.arguments.requested_time === "string",
    },
  });
}

function buildExecutionContext(
  input: RuntimeAgentTurnInput,
  request: RuntimeAgentToolRequest,
  planner: PlannerOutput,
  truth_snapshot: TruthSnapshot,
  now?: Date,
): ToolExecutionContext {
  // service_interest: availability.check uses "service_interest"; booking.apply uses "service".
  const serviceInterest =
    typeof request.arguments.service_interest === "string"
      ? request.arguments.service_interest
      : typeof request.arguments.service === "string"
        ? request.arguments.service
        : null;

  return {
    trace_id: input.trace_id,
    clinic_id: input.clinic_id,
    contact_id: input.contact_id ?? undefined,
    case_id: input.case_id ?? undefined,
    locale: input.locale,
    query_text: typeof request.arguments.query === "string" ? request.arguments.query : undefined,
    requested_date: typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : undefined,
    requested_time: typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null,
    service_interest: serviceInterest,
    limit: typeof request.arguments.limit === "number" ? request.arguments.limit : undefined,
    timezone: typeof request.arguments.timezone === "string" ? request.arguments.timezone : undefined,
    planner,
    truth_snapshot,
    now,
    // booking.apply fields — from model args and channel_contact.
    first_name: typeof request.arguments.first_name === "string" ? request.arguments.first_name : undefined,
    last_name: typeof request.arguments.last_name === "string" ? request.arguments.last_name : undefined,
    phone_number: input.channel_contact?.phone_number,
    phone_source: input.channel_contact?.phone_source,
  } as ToolExecutionContext;
}

function convertToolExecutionResult(
  request: RuntimeAgentToolRequest,
  result: ToolExecutionResult | undefined,
): RuntimeAgentToolResult {
  if (!result) {
    return {
      tool: request.tool,
      call_id: request.call_id,
      status: "failed",
      error: { code: "missing_execution_result", message: "Tool execution produced no result" },
    };
  }

  if (result.status === "success") {
    return { tool: request.tool, call_id: request.call_id, status: "success", data: result.data };
  }

  if (result.status === "not_implemented") {
    return {
      tool: request.tool,
      call_id: request.call_id,
      status: "failed",
      error: result.error ?? { code: "tool_not_implemented", message: "Tool not implemented", retryable: false },
    };
  }

  return {
    tool: request.tool,
    call_id: request.call_id,
    status: "failed",
    error: result.error,
  };
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

import {
  buildRuntimeAgentSystemInstruction,
  type AgentUiActions,
  type OpenAIRuntimeAgent,
  type RuntimeAgentToolResult,
  type RuntimeAgentTurnInput,
  type RuntimeAgentTurnResult,
} from "./openaiRuntimeAgent.ts";
import type { ToolExecutorRegistry } from "./toolExecutor.ts";
import type { ConversationMemoryRepository } from "./runtimeRepositories.ts";
import { buildModelVisibleCallerContext } from "./modelVisibleCallerContext.ts";
import { buildRuntimeLlmCallDebug } from "./llmCallDebug.ts";
import { buildBookingApplyEmergencyFallback } from "./bookingApplyGuard.ts";
import { buildCallerExceptionDiagnostics, sanitizeErrorMessage } from "./callerExceptionDiagnostics.ts";
import { hasTrustedPhone, hasBookingApplyPending } from "./bookingContactGuard.ts";
import { buildPastTimeReply } from "./bookingPreflight.ts";
import {
  computeBookingProcessState,
  buildModelVisibleBookingProcessState,
  hasMeaningfulBookingState,
  type BookingProcessStateRepository,
  type BookingProcessState,
  type ModelVisibleBookingProcessState,
} from "./bookingProcessState.ts";
import { buildPhoneCaptureUi, sanitizePhoneCaptureUiForChannel } from "./channelCapabilityPolicy.ts";
import { runRuntimeTurnModelToolOrchestration } from "./runtimeTurnModelToolOrchestrator.ts";
import type { RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";
import { createRuntimeModelIterationState } from "./runtimeModelIteration.ts";
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

      const persistBookingProcessState = (state: BookingProcessState): void => {
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
    },
  };
}

export interface GuardedBookingApplyData {
  booking_status: string;
  created_visit: false;
  may_claim_booked: false;
  required_next_action: string;
  reason: string;
  missing_fields?: string[];
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

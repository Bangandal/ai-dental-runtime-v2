import {
  ACTIVE_RUNTIME_AGENT_TOOLS,
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  buildRuntimeAgentSystemInstruction,
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
  now?: Date;
  timezone?: string;
}

const ACTIVE_TOOL_SET = new Set<string>(ACTIVE_RUNTIME_AGENT_TOOLS);

export function createRuntimeAgentLoop(deps: CreateRuntimeAgentLoopDeps): OpenAIRuntimeAgent {
  return {
    async runTurn(input: RuntimeAgentTurnInput): Promise<RuntimeAgentTurnResult> {
      const debug: Record<string, unknown> = { llm_calls: buildRuntimeLlmCallDebug() };
      const systemInstruction = buildRuntimeAgentSystemInstruction({
        now: deps.now,
        timezone: deps.timezone,
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

      let firstOutput: RuntimeAgentCallerOutput;
      try {
        debug.llm_calls = buildRuntimeLlmCallDebug({ main_agent_called: true });
        firstOutput = await deps.caller({
          model: deps.model,
          conversation_id: conversationId,
          system_instruction: systemInstruction,
          input: {
            message: input.user_message,
            context: callerContext,
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
          tool_requests: [],
          tool_results: [],
          debug,
        };
      }

      if (firstOutput.type === "final_response") {
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: firstOutput.final_response.final_patient_reply,
          conversation_id: conversationId,
          tool_requests: [],
          tool_results: [],
          debug,
          ui: firstOutput.final_response.ui,
        };
      }

      const toolRequests = firstOutput.tool_requests;
      const toolResults: RuntimeAgentToolResult[] = [];

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
        const truth = resolveTruthSnapshot(input, request, planner, deps.now);
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

        const executionContext = buildExecutionContext(input, request, planner, truth, deps.now);
        const executionResults = await executeAllowedTools({
          tools_allowed: policy.tools_allowed,
          registry: deps.executors,
          context: executionContext,
        });
        toolResults.push(convertToolExecutionResult(request, executionResults[0]));
      }

      const bookingActionTruth = buildBookingApplyActionTruth(toolResults);
      const secondCallContext = bookingActionTruth
        ? { ...callerContext, booking_apply_action_truth: bookingActionTruth }
        : callerContext;

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
            await saveConversationMemory(deps.conversationMemoryRepository, input, null, debug);
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
            await saveConversationMemory(deps.conversationMemoryRepository, input, null, debug);
            return {
              final_patient_reply: forcedOutput.final_response.final_patient_reply,
              conversation_id: null,
              conversation_id_resumable: false,
              tool_requests: toolRequests,
              tool_results: toolResults,
              debug,
              ui: forcedOutput.final_response.ui,
            };
          }
        }

        debug.reason = "multi_round_tool_loop_not_implemented";
        markConversationDirty(debug);
        await saveConversationMemory(deps.conversationMemoryRepository, input, null, debug);
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
        ui: secondOutput.final_response.ui,
      };
    },
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

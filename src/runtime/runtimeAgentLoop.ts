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
          message: error instanceof Error ? error.message : String(error),
        };
        return {
          final_patient_reply: "Sorry, I’m having trouble processing that right now. Please try again in a moment.",
          conversation_id: conversationId,
          tool_requests: [],
          tool_results: [],
          debug,
        };
      }

      if (firstOutput.conversation_id !== undefined) {
        conversationId = firstOutput.conversation_id;
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

      let secondOutput: RuntimeAgentCallerOutput;
      try {
        secondOutput = await deps.caller({
          model: deps.model,
          conversation_id: conversationId,
          system_instruction: systemInstruction,
          input: {
            message: input.user_message,
            context: callerContext,
            tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
            tool_results: toolResults,
          },
        });
      } catch (error) {
        debug.runtime_error = {
          code: "agent_final_response_failed",
          message: error instanceof Error ? error.message : String(error),
        };
        return {
          final_patient_reply: "I found the information, but I’m having trouble wording the reply right now. Please try again in a moment.",
          conversation_id: conversationId,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
        };
      }

      if (secondOutput.conversation_id !== undefined) {
        conversationId = secondOutput.conversation_id;
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
                context: { ...callerContext, resolved_context: toolResults },
                // No tool_definitions → caller sends tools:[] → model must produce final_response.
                // No tool_results → no function_call_output protocol messages.
              },
            });
          } catch {
            // Forced finalization failed — fall through to locale-aware fallback.
          }
          if (forcedOutput !== undefined && forcedOutput.type === "final_response") {
            // Do not update conversationId: forced finalization used a fresh conversation,
            // unrelated to the patient's rounds 1-2 thread. The original conversationId
            // is preserved so memory save and result are consistent.
            debug.reason = "forced_finalization_after_tool_results";
            await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
            return {
              final_patient_reply: forcedOutput.final_response.final_patient_reply,
              conversation_id: conversationId,
              tool_requests: toolRequests,
              tool_results: toolResults,
              debug,
              ui: forcedOutput.final_response.ui,
            };
          }
        }

        debug.reason = "multi_round_tool_loop_not_implemented";
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: buildMultiRoundFallbackReply(input.locale),
          conversation_id: conversationId,
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

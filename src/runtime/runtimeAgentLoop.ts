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

export interface RuntimeAgentCallerInput {
  model: string;
  conversation_id?: string | null;
  system_instruction: string;
  input: {
    message: string;
    context: Record<string, unknown>;
    tool_definitions: typeof RUNTIME_AGENT_TOOL_DEFINITIONS;
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
}

const ACTIVE_TOOL_SET = new Set<string>(ACTIVE_RUNTIME_AGENT_TOOLS);
const BOOKING_INTENT_PATTERNS = [
  /хочу записаться/i,
  /можно записаться/i,
  /когда есть место/i,
  /есть свободное время/i,
  /хочу прийти/i,
  /можно на завтра/i,
  /запишите меня/i,
];
const CTA_PHRASE_PATTERNS = [
  /если хотите,\s*могу помочь записаться/i,
  /могу помочь записаться/i,
  /хотите записаться/i,
  /can help you book/i,
  /i can help you schedule/i,
];

type ReplyPolicyMode = "pure_faq" | "booking_intent" | "unknown";

export function createRuntimeAgentLoop(deps: CreateRuntimeAgentLoopDeps): OpenAIRuntimeAgent {
  return {
    async runTurn(input: RuntimeAgentTurnInput): Promise<RuntimeAgentTurnResult> {
      const debug: Record<string, unknown> = {};
      const systemInstruction = buildRuntimeAgentSystemInstruction();
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
        const policyApplied = applyReplyPolicyGuard(input.user_message, firstOutput.final_response.final_patient_reply, []);
        debug.reply_policy = policyApplied.debug;
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: policyApplied.final_patient_reply,
          conversation_id: conversationId,
          tool_requests: [],
          tool_results: [],
          debug,
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
        debug.reason = "multi_round_tool_loop_not_implemented";
        await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
        return {
          final_patient_reply: "Let me clarify that with the clinic team.",
          conversation_id: conversationId,
          tool_requests: toolRequests,
          tool_results: toolResults,
          debug,
        };
      }

      const policyApplied = applyReplyPolicyGuard(
        input.user_message,
        secondOutput.final_response.final_patient_reply,
        toolRequests.map((request) => request.tool),
      );
      debug.reply_policy = policyApplied.debug;
      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);
      return {
        final_patient_reply: policyApplied.final_patient_reply,
        conversation_id: conversationId,
        tool_requests: toolRequests,
        tool_results: toolResults,
        debug,
      };
    },
  };
}

function applyReplyPolicyGuard(
  userMessage: string,
  reply: string,
  requestedTools: RuntimeAgentToolRequest["tool"][],
): {
  final_patient_reply: string;
  debug: {
    mode: ReplyPolicyMode;
    booking_cta_allowed: boolean;
    cta_suppressed: boolean;
  };
} {
  const mode = classifyReplyPolicyMode(userMessage, requestedTools);
  const bookingCtaAllowed = mode === "booking_intent";
  if (bookingCtaAllowed) {
    return {
      final_patient_reply: reply,
      debug: { mode, booking_cta_allowed: true, cta_suppressed: false },
    };
  }

  const cleanedReply = removeBookingCtaSentences(reply);
  return {
    final_patient_reply: cleanedReply,
    debug: { mode, booking_cta_allowed: false, cta_suppressed: cleanedReply !== reply },
  };
}

function classifyReplyPolicyMode(
  userMessage: string,
  requestedTools: RuntimeAgentToolRequest["tool"][],
): ReplyPolicyMode {
  if (BOOKING_INTENT_PATTERNS.some((pattern) => pattern.test(userMessage))) {
    return "booking_intent";
  }
  if (requestedTools.length === 0 || requestedTools.every((tool) => tool === "kb.search")) {
    return "pure_faq";
  }
  return "unknown";
}

function removeBookingCtaSentences(reply: string): string {
  const parts = reply.split(/(?<=[.!?])\s+/u);
  const filtered = parts.filter((part) => !CTA_PHRASE_PATTERNS.some((pattern) => pattern.test(part)));
  const merged = filtered.join(" ").trim();
  return merged.length > 0 ? merged : reply.trim();
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
      scheduling_intent_present: request.tool === "availability.check",
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
  return {
    trace_id: input.trace_id,
    clinic_id: input.clinic_id,
    contact_id: input.contact_id ?? undefined,
    case_id: input.case_id ?? undefined,
    locale: input.locale,
    query_text: typeof request.arguments.query === "string" ? request.arguments.query : undefined,
    requested_date: typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : undefined,
    requested_time: typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null,
    service_interest: typeof request.arguments.service_interest === "string" ? request.arguments.service_interest : null,
    limit: typeof request.arguments.limit === "number" ? request.arguments.limit : undefined,
    timezone: typeof request.arguments.timezone === "string" ? request.arguments.timezone : undefined,
    planner,
    truth_snapshot,
    now,
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

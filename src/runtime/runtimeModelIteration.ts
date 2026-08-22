import { RUNTIME_AGENT_TOOL_DEFINITIONS, type RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import {
  appendAgentFirstSystemInstruction,
  resolveRuntimeModelCallBudget,
} from "./agentFirstRuntimePolicy.ts";
import {
  invokeRuntimeModelCall,
  type RuntimeAgentCaller,
  type RuntimeAgentCallerOutput,
} from "./runtimeModelCall.ts";

export const DEFAULT_RUNTIME_MODEL_CALL_BUDGET = 3;

export interface RuntimeModelIterationState {
  conversation_id: string | null;
  calls_used: number;
  max_calls: number;
}

export function createRuntimeModelIterationState(
  conversationId: string | null,
  maxCalls = resolveRuntimeModelCallBudget(),
): RuntimeModelIterationState {
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new Error("runtime model call budget must be a positive integer");
  }
  return {
    conversation_id: conversationId,
    calls_used: 0,
    max_calls: maxCalls,
  };
}

export type RuntimeModelIterationOutcome =
  | {
      kind: "model_output";
      output: RuntimeAgentCallerOutput;
      state: RuntimeModelIterationState;
    }
  | {
      kind: "call_failed";
      error: unknown;
      state: RuntimeModelIterationState;
    }
  | {
      kind: "budget_exhausted";
      state: RuntimeModelIterationState;
    };

/**
 * Transport-state boundary for one bounded runtime model iteration.
 *
 * Business legality deliberately does not live here. This layer owns only:
 * - the resumable OpenAI conversation id;
 * - how many model invocations have actually been attempted;
 * - the hard per-turn model-call budget.
 *
 * A failed upstream invocation still consumes budget because a real transport attempt
 * occurred. Tool execution, booking guards, fallbacks, and dirty-conversation policy remain
 * responsibilities of the runtime orchestrator.
 */
export async function invokeRuntimeModelIteration(params: {
  state: RuntimeModelIterationState;
  caller: RuntimeAgentCaller;
  model: string;
  system_instruction: string;
  message: string;
  context: Record<string, unknown>;
  tool_definitions?: typeof RUNTIME_AGENT_TOOL_DEFINITIONS;
  tool_results?: RuntimeAgentToolResult[];
}): Promise<RuntimeModelIterationOutcome> {
  if (params.state.calls_used >= params.state.max_calls) {
    return { kind: "budget_exhausted", state: params.state };
  }

  const call = await invokeRuntimeModelCall({
    caller: params.caller,
    model: params.model,
    conversation_id: params.state.conversation_id,
    system_instruction: appendAgentFirstSystemInstruction(params.system_instruction),
    message: params.message,
    context: params.context,
    ...(params.tool_definitions !== undefined ? { tool_definitions: params.tool_definitions } : {}),
    ...(params.tool_results !== undefined ? { tool_results: params.tool_results } : {}),
  });

  const nextState: RuntimeModelIterationState = {
    ...params.state,
    calls_used: params.state.calls_used + 1,
    conversation_id: call.conversation_id,
  };

  if (!call.ok) {
    return {
      kind: "call_failed",
      error: call.error,
      state: nextState,
    };
  }

  return {
    kind: "model_output",
    output: call.output,
    state: nextState,
  };
}

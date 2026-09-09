import {
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  type RuntimeAgentToolRequest,
  type RuntimeAgentToolResult,
} from "./openaiRuntimeAgent.ts";
import type { RuntimeAgentCaller, RuntimeAgentCallerOutput } from "./runtimeModelCall.ts";
import {
  invokeRuntimeModelIteration,
  type RuntimeModelIterationState,
} from "./runtimeModelIteration.ts";

export interface RuntimeBoundedLoopFrame<TDomainState> {
  domain_state: TDomainState;
  context: Record<string, unknown>;
  tool_results?: RuntimeAgentToolResult[];
  /** Business guard result. False blocks the attempted action, but does not prevent conversational recovery. */
  allow_tools: boolean;
}

export type RuntimeBoundedLoopBatchTransition<TDomainState> =
  | { kind: "continue"; frame: RuntimeBoundedLoopFrame<TDomainState> }
  | { kind: "abort"; domain_state: TDomainState; reason: string };

export type RuntimeBoundedModelToolLoopOutcome<TDomainState> =
  | {
      kind: "final_response";
      output: Extract<RuntimeAgentCallerOutput, { type: "final_response" }>;
      model_state: RuntimeModelIterationState;
      domain_state: TDomainState;
      call_number: number;
    }
  | {
      kind: "call_failed";
      error: unknown;
      model_state: RuntimeModelIterationState;
      domain_state: TDomainState;
      call_number: number;
    }
  | {
      kind: "budget_exhausted";
      model_state: RuntimeModelIterationState;
      domain_state: TDomainState;
      call_number: number;
    }
  | {
      kind: "tool_request_at_budget_limit";
      requests: RuntimeAgentToolRequest[];
      model_state: RuntimeModelIterationState;
      domain_state: TDomainState;
      call_number: number;
    }
  | {
      kind: "batch_aborted";
      reason: string;
      model_state: RuntimeModelIterationState;
      domain_state: TDomainState;
      call_number: number;
    };

/**
 * Generic bounded model <-> deterministic-tool iterator.
 * Business legality lives in execute_batch. A denied action never terminates the model's
 * ability to recover conversationally; only the hard model-call budget is terminal.
 */
export async function runRuntimeBoundedModelToolLoop<TDomainState>(params: {
  model_state: RuntimeModelIterationState;
  domain_state: TDomainState;
  caller: RuntimeAgentCaller;
  model: string;
  system_instruction: string;
  message: string;
  initial_context: Record<string, unknown>;
  execute_batch: (args: {
    requests: RuntimeAgentToolRequest[];
    domain_state: TDomainState;
    batch_number: number;
  }) => Promise<RuntimeBoundedLoopBatchTransition<TDomainState>>;
}): Promise<RuntimeBoundedModelToolLoopOutcome<TDomainState>> {
  let modelState = params.model_state;
  let frame: RuntimeBoundedLoopFrame<TDomainState> = {
    domain_state: params.domain_state,
    context: params.initial_context,
    allow_tools: true,
  };
  let batchNumber = 0;

  while (true) {
    const callNumber = modelState.calls_used + 1;
    const hasFutureModelCall = modelState.calls_used < modelState.max_calls - 1;

    const step = await invokeRuntimeModelIteration({
      state: modelState,
      caller: params.caller,
      model: params.model,
      system_instruction: params.system_instruction,
      message: params.message,
      context: frame.context,
      ...(hasFutureModelCall ? { tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS } : {}),
      ...(frame.tool_results !== undefined ? { tool_results: frame.tool_results } : {}),
    });
    modelState = step.state;

    if (step.kind === "budget_exhausted") {
      return {
        kind: "budget_exhausted",
        model_state: modelState,
        domain_state: frame.domain_state,
        call_number: callNumber,
      };
    }
    if (step.kind === "call_failed") {
      return {
        kind: "call_failed",
        error: step.error,
        model_state: modelState,
        domain_state: frame.domain_state,
        call_number: callNumber,
      };
    }
    if (step.output.type === "final_response") {
      return {
        kind: "final_response",
        output: step.output,
        model_state: modelState,
        domain_state: frame.domain_state,
        call_number: callNumber,
      };
    }
    if (!hasFutureModelCall) {
      return {
        kind: "tool_request_at_budget_limit",
        requests: step.output.tool_requests,
        model_state: modelState,
        domain_state: frame.domain_state,
        call_number: callNumber,
      };
    }

    batchNumber += 1;
    const transition = await params.execute_batch({
      requests: step.output.tool_requests,
      domain_state: frame.domain_state,
      batch_number: batchNumber,
    });
    if (transition.kind === "abort") {
      return {
        kind: "batch_aborted",
        reason: transition.reason,
        model_state: modelState,
        domain_state: transition.domain_state,
        call_number: callNumber,
      };
    }
    frame = transition.frame;
  }
}

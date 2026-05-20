import {
  buildRuntimeDebugEnvelopeFromPipelineResult,
  type RuntimeDebugEnvelope,
} from "./debugEnvelope.ts";
import {
  buildToolExecutionPlan,
  executeAllowedTools,
  type ToolExecutionContext,
  type ToolExecutorRegistry,
} from "./toolExecutor.ts";
import type { ToolExecutionPlan, ToolExecutionResult } from "./toolResults.ts";
import type { BackendEventType } from "./toolPolicy.ts";
import { runRuntimeTurnPipeline, type RuntimeTurnPipelineResult } from "./runtimeTurnPipeline.ts";
import type { TruthSnapshotInput } from "./truthSnapshot.ts";

export interface RuntimeTurnDryRunInput {
  trace_id?: string;
  created_at?: string | Date;
  contact_id?: string | null;
  case_id?: string | null;
  clinic_id?: string | null;
  channel?: string | null;
  external_user_id?: string | null;
  conversation_id?: string | null;
  raw_planner_output: unknown;
  truth_input: TruthSnapshotInput;
  backend_events?: BackendEventType[];
  executor_registry?: ToolExecutorRegistry;
  execution_context?: Partial<ToolExecutionContext>;
  started_at?: number;
  ended_at?: number;
}

export interface RuntimeTurnDryRunResult {
  pipeline_result: RuntimeTurnPipelineResult;
  execution_plan: ToolExecutionPlan;
  tool_results: ToolExecutionResult[];
  debug_envelope: RuntimeDebugEnvelope;
}

export async function runRuntimeTurnDry(
  input: RuntimeTurnDryRunInput,
): Promise<RuntimeTurnDryRunResult> {
  const pipelineResult = runRuntimeTurnPipeline({
    raw_planner_output: input.raw_planner_output,
    truth_input: input.truth_input,
    backend_events: input.backend_events,
  });

  const executionPlan = buildToolExecutionPlan(pipelineResult.policy_result);

  const latencyMs =
    typeof input.started_at === "number" && typeof input.ended_at === "number"
      ? input.ended_at - input.started_at
      : null;

  const executionContext: ToolExecutionContext = {
    ...input.execution_context,
    trace_id: input.trace_id ?? input.execution_context?.trace_id ?? undefined,
    contact_id: input.contact_id ?? input.execution_context?.contact_id ?? undefined,
    case_id: input.case_id ?? input.execution_context?.case_id ?? undefined,
    planner: pipelineResult.planner,
    truth_snapshot: pipelineResult.truth_snapshot,
  };

  try {
    const toolResults = await executeAllowedTools({
      tools_allowed: executionPlan.tools_allowed,
      registry: input.executor_registry,
      context: executionContext,
    });

    return {
      pipeline_result: pipelineResult,
      execution_plan: executionPlan,
      tool_results: toolResults,
      debug_envelope: buildRuntimeDebugEnvelopeFromPipelineResult({
        trace_id: input.trace_id,
        created_at: input.created_at,
        contact_id: input.contact_id,
        case_id: input.case_id,
        clinic_id: input.clinic_id,
        channel: input.channel,
        external_user_id: input.external_user_id,
        conversation_id: input.conversation_id,
        pipeline_result: pipelineResult,
        tool_results: toolResults,
        latency_ms: latencyMs,
      }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      pipeline_result: pipelineResult,
      execution_plan: executionPlan,
      tool_results: [],
      debug_envelope: buildRuntimeDebugEnvelopeFromPipelineResult({
        trace_id: input.trace_id,
        created_at: input.created_at,
        contact_id: input.contact_id,
        case_id: input.case_id,
        clinic_id: input.clinic_id,
        channel: input.channel,
        external_user_id: input.external_user_id,
        conversation_id: input.conversation_id,
        pipeline_result: pipelineResult,
        tool_results: [],
        latency_ms: latencyMs,
        runtime_error: {
          code: "execute_allowed_tools_unexpected_error",
          message: errorMessage,
          retryable: true,
        },
      }),
    };
  }
}

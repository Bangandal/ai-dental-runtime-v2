import { buildRuntimeDebugEnvelope, type RuntimeDebugEnvelope } from "./debugEnvelope.ts";
import { parsePlannerOutput, type PlannerParseResult } from "./plannerOutput.ts";
import type { OpenAIPlanner, OpenAIPlannerResult } from "./openaiPlanner.ts";
import {
  buildToolExecutionPlan,
  executeAllowedTools,
  type ToolExecutionContext,
  type ToolExecutorRegistry,
} from "./toolExecutor.ts";
import type { ToolExecutionPlan, ToolExecutionResult } from "./toolResults.ts";
import {
  applyToolPolicy,
  deriveRuntimeSideEffects,
  type BackendEventType,
  type PolicyResult,
  type RuntimeSideEffect,
  type TruthSnapshot,
} from "./toolPolicy.ts";
import { buildTruthSnapshot, type TruthSnapshotInput } from "./truthSnapshot.ts";

export type TruthSnapshotBuilderInput = TruthSnapshotInput;

export interface RuntimeTurnAssemblyInput {
  trace_id?: string;
  clinic_id: string;
  contact_id?: string;
  case_id?: string;
  conversation_id?: string | null;
  user_message: string;
  locale?: string | null;
  truth_input?: Partial<TruthSnapshotBuilderInput>;
  execution_context?: Partial<ToolExecutionContext>;
  backend_events?: BackendEventType[];
  recent_summary?: string | null;
  business_context?: Record<string, unknown>;
}

export interface RuntimeTurnAssemblyDeps {
  planner: OpenAIPlanner;
  executors: ToolExecutorRegistry;
  now?: Date;
}

export interface RuntimeTurnAssemblyResult {
  planner_result: OpenAIPlannerResult | null;
  parsed_planner: PlannerParseResult;
  truth_snapshot: TruthSnapshot;
  policy_result: PolicyResult;
  execution_plan: ToolExecutionPlan;
  tool_results: ToolExecutionResult[];
  side_effects: RuntimeSideEffect[];
  debug_envelope: RuntimeDebugEnvelope;
  conversation_id?: string | null;
}

function buildSafeContext(input: RuntimeTurnAssemblyInput, parsedPlanner: PlannerParseResult, truth: TruthSnapshot): ToolExecutionContext {
  const executionContext = input.execution_context ?? {};

  return {
    ...executionContext,
    trace_id: input.trace_id ?? executionContext.trace_id,
    clinic_id: input.clinic_id,
    contact_id: input.contact_id ?? executionContext.contact_id,
    case_id: input.case_id ?? executionContext.case_id,
    conversation_id: input.conversation_id ?? executionContext.conversation_id,
    locale: input.locale ?? executionContext.locale,
    planner: parsedPlanner.planner,
    truth_snapshot: truth,
  };
}

export async function runRuntimeTurnAssembly(
  input: RuntimeTurnAssemblyInput,
  deps: RuntimeTurnAssemblyDeps,
): Promise<RuntimeTurnAssemblyResult> {
  const now = deps.now ?? new Date();

  try {
    const plannerResult = await deps.planner.plan({
      trace_id: input.trace_id,
      clinic_id: input.clinic_id,
      contact_id: input.contact_id,
      case_id: input.case_id,
      conversation_id: input.conversation_id,
      user_message: input.user_message,
      locale: input.locale,
      recent_summary: input.recent_summary,
      business_context: input.business_context,
      truth_snapshot_hint: input.truth_input as Record<string, unknown> | undefined,
    });

    const parsedPlanner = parsePlannerOutput(plannerResult.raw_planner_output);
    const truthSnapshot = buildTruthSnapshot({ ...(input.truth_input ?? {}), planner: parsedPlanner.planner, now });
    const policyResult = applyToolPolicy(parsedPlanner.planner, truthSnapshot);
    const executionPlan = buildToolExecutionPlan(policyResult);
    const sideEffects = deriveRuntimeSideEffects(parsedPlanner.planner.confidence, input.backend_events ?? []);

    const toolResults = await executeAllowedTools({
      tools_allowed: executionPlan.tools_allowed,
      registry: deps.executors,
      context: buildSafeContext(input, parsedPlanner, truthSnapshot),
    });

    return {
      planner_result: plannerResult,
      parsed_planner: parsedPlanner,
      truth_snapshot: truthSnapshot,
      policy_result: policyResult,
      execution_plan: executionPlan,
      tool_results: toolResults,
      side_effects: sideEffects,
      debug_envelope: buildRuntimeDebugEnvelope({
        trace_id: input.trace_id,
        created_at: now,
        clinic_id: input.clinic_id,
        contact_id: input.contact_id,
        case_id: input.case_id,
        conversation_id: plannerResult.conversation_id,
        planner_parse_result: parsedPlanner,
        truth_snapshot: truthSnapshot,
        policy_result: policyResult,
        tool_results: toolResults,
        side_effects: sideEffects,
      }),
      conversation_id: plannerResult.conversation_id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const parsedPlanner = parsePlannerOutput(null);
    const truthSnapshot = buildTruthSnapshot({ ...(input.truth_input ?? {}), planner: parsedPlanner.planner, now });
    const policyResult = applyToolPolicy(parsedPlanner.planner, truthSnapshot);
    const executionPlan = buildToolExecutionPlan(policyResult);
    const sideEffects = deriveRuntimeSideEffects(parsedPlanner.planner.confidence, input.backend_events ?? []);

    return {
      planner_result: null,
      parsed_planner: parsedPlanner,
      truth_snapshot: truthSnapshot,
      policy_result: policyResult,
      execution_plan: executionPlan,
      tool_results: [],
      side_effects: sideEffects,
      debug_envelope: buildRuntimeDebugEnvelope({
        trace_id: input.trace_id,
        created_at: now,
        clinic_id: input.clinic_id,
        contact_id: input.contact_id,
        case_id: input.case_id,
        conversation_id: input.conversation_id,
        planner_parse_result: parsedPlanner,
        truth_snapshot: truthSnapshot,
        policy_result: policyResult,
        tool_results: [],
        side_effects: sideEffects,
        runtime_error: {
          code: "planner_execution_failed",
          message,
          retryable: true,
        },
      }),
      conversation_id: input.conversation_id,
    };
  }
}

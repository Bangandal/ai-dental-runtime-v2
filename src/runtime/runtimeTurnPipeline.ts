import { parsePlannerOutput, type PlannerParseResult } from "./plannerOutput.ts";
import { buildTruthSnapshot, type TruthSnapshotInput } from "./truthSnapshot.ts";
import {
  applyToolPolicy,
  deriveRuntimeSideEffects,
  type BackendEventType,
  type PlannerOutput,
  type PolicyResult,
  type RuntimeSideEffect,
  type TruthSnapshot,
} from "./toolPolicy.ts";

export interface RuntimeTurnPipelineInput {
  raw_planner_output: unknown;
  truth_input: TruthSnapshotInput;
  backend_events?: BackendEventType[];
}

export interface RuntimeTurnPipelineDebugSummary {
  turn_type: PlannerOutput["turn_type"];
  confidence: PlannerOutput["confidence"];
  tools_requested: PlannerOutput["tools_requested"];
  tools_allowed: PolicyResult["tools_allowed"];
  tools_denied: PolicyResult["tools_denied"];
  booking_action: PolicyResult["booking_action"];
  reply_strategy: PolicyResult["reply_strategy"];
  parse_ok: PlannerParseResult["ok"];
  parse_errors: PlannerParseResult["errors"];
  parse_warnings: PlannerParseResult["warnings"];
}

export interface RuntimeTurnPipelineResult {
  planner_parse_result: PlannerParseResult;
  planner: PlannerOutput;
  truth_snapshot: TruthSnapshot;
  policy_result: PolicyResult;
  side_effects: RuntimeSideEffect[];
  debug_summary: RuntimeTurnPipelineDebugSummary;
}

export function runRuntimeTurnPipeline(input: RuntimeTurnPipelineInput): RuntimeTurnPipelineResult {
  const plannerParseResult = parsePlannerOutput(input.raw_planner_output);

  const truthSnapshot = buildTruthSnapshot({
    ...input.truth_input,
    planner: plannerParseResult.planner,
  });

  const policyResult = applyToolPolicy(plannerParseResult.planner, truthSnapshot);

  const sideEffects = deriveRuntimeSideEffects(
    plannerParseResult.planner.confidence,
    input.backend_events ?? [],
  );

  return {
    planner_parse_result: plannerParseResult,
    planner: plannerParseResult.planner,
    truth_snapshot: truthSnapshot,
    policy_result: policyResult,
    side_effects: sideEffects,
    debug_summary: {
      turn_type: plannerParseResult.planner.turn_type,
      confidence: plannerParseResult.planner.confidence,
      tools_requested: plannerParseResult.planner.tools_requested,
      tools_allowed: policyResult.tools_allowed,
      tools_denied: policyResult.tools_denied,
      booking_action: policyResult.booking_action,
      reply_strategy: policyResult.reply_strategy,
      parse_ok: plannerParseResult.ok,
      parse_errors: plannerParseResult.errors,
      parse_warnings: plannerParseResult.warnings,
    },
  };
}

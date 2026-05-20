import type { PlannerParseResult } from "./plannerOutput.ts";
import type { RuntimeTurnPipelineResult } from "./runtimeTurnPipeline.ts";
import type {
  BookingAction,
  PolicyResult,
  ReplyStrategy,
  RuntimeSideEffect,
  ToolDecision,
  ToolName,
  TruthSnapshot,
} from "./toolPolicy.ts";
import type { PlannerOutput } from "./toolPolicy.ts";
import type { ToolExecutionResult } from "./toolResults.ts";

export type RuntimeDebugEnvelopeVersion = "runtime_debug_envelope_v1";

export interface RuntimeDebugEnvelope {
  version: RuntimeDebugEnvelopeVersion;
  trace_id: string;
  created_at: string;
  contact_id?: string | null;
  case_id?: string | null;
  clinic_id?: string | null;
  channel?: string | null;
  external_user_id?: string | null;
  conversation_id?: string | null;
  planner_parse_ok: boolean;
  planner_parse_errors: string[];
  planner_parse_warnings: string[];
  planner_output: PlannerOutput;
  truth_snapshot: TruthSnapshot;
  tools_requested: string[];
  tools_allowed: ToolName[];
  tools_denied: ToolDecision[];
  reply_strategy: ReplyStrategy;
  booking_action: BookingAction;
  tool_results: ToolExecutionResult[];
  side_effects: RuntimeSideEffect[];
  latency_ms?: number | null;
  runtime_error?: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
}

export interface BuildRuntimeDebugEnvelopeInput {
  trace_id?: string;
  created_at?: string | Date;
  contact_id?: string | null;
  case_id?: string | null;
  clinic_id?: string | null;
  channel?: string | null;
  external_user_id?: string | null;
  conversation_id?: string | null;
  planner_parse_result: PlannerParseResult;
  truth_snapshot: TruthSnapshot;
  policy_result: PolicyResult;
  tool_results?: ToolExecutionResult[];
  side_effects?: RuntimeSideEffect[];
  latency_ms?: number | null;
  runtime_error?: RuntimeDebugEnvelope["runtime_error"];
}

export interface BuildRuntimeDebugEnvelopeFromPipelineResultInput {
  trace_id?: string;
  created_at?: string | Date;
  contact_id?: string | null;
  case_id?: string | null;
  clinic_id?: string | null;
  channel?: string | null;
  external_user_id?: string | null;
  conversation_id?: string | null;
  pipeline_result: RuntimeTurnPipelineResult;
  tool_results?: ToolExecutionResult[];
  latency_ms?: number | null;
  runtime_error?: RuntimeDebugEnvelope["runtime_error"];
}

const DEBUG_ENVELOPE_VERSION: RuntimeDebugEnvelopeVersion = "runtime_debug_envelope_v1";

function normalizeCreatedAt(createdAt?: string | Date): string {
  if (createdAt instanceof Date) {
    return createdAt.toISOString();
  }

  if (typeof createdAt === "string") {
    return createdAt;
  }

  return new Date().toISOString();
}

export function buildRuntimeDebugEnvelope(
  input: BuildRuntimeDebugEnvelopeInput,
): RuntimeDebugEnvelope {
  return {
    version: DEBUG_ENVELOPE_VERSION,
    trace_id: input.trace_id ?? "trace_missing",
    created_at: normalizeCreatedAt(input.created_at),
    contact_id: input.contact_id,
    case_id: input.case_id,
    clinic_id: input.clinic_id,
    channel: input.channel,
    external_user_id: input.external_user_id,
    conversation_id: input.conversation_id,
    planner_parse_ok: input.planner_parse_result.ok,
    planner_parse_errors: input.planner_parse_result.errors,
    planner_parse_warnings: input.planner_parse_result.warnings,
    planner_output: input.planner_parse_result.planner,
    truth_snapshot: input.truth_snapshot,
    tools_requested: input.planner_parse_result.planner.tools_requested,
    tools_allowed: input.policy_result.tools_allowed,
    tools_denied: input.policy_result.tools_denied,
    reply_strategy: input.policy_result.reply_strategy,
    booking_action: input.policy_result.booking_action,
    tool_results: input.tool_results ?? [],
    side_effects: input.side_effects ?? [],
    latency_ms: input.latency_ms,
    runtime_error: input.runtime_error ?? null,
  };
}

export function buildRuntimeDebugEnvelopeFromPipelineResult(
  input: BuildRuntimeDebugEnvelopeFromPipelineResultInput,
): RuntimeDebugEnvelope {
  return buildRuntimeDebugEnvelope({
    trace_id: input.trace_id,
    created_at: input.created_at,
    contact_id: input.contact_id,
    case_id: input.case_id,
    clinic_id: input.clinic_id,
    channel: input.channel,
    external_user_id: input.external_user_id,
    conversation_id: input.conversation_id,
    planner_parse_result: input.pipeline_result.planner_parse_result,
    truth_snapshot: input.pipeline_result.truth_snapshot,
    policy_result: input.pipeline_result.policy_result,
    tool_results: input.tool_results,
    side_effects: input.pipeline_result.side_effects,
    latency_ms: input.latency_ms,
    runtime_error: input.runtime_error,
  });
}

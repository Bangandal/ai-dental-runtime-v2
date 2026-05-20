import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { parsePlannerOutput } from "../src/runtime/plannerOutput.ts";
import { runRuntimeTurnPipeline } from "../src/runtime/runtimeTurnPipeline.ts";
import {
  buildRuntimeDebugEnvelope,
  buildRuntimeDebugEnvelopeFromPipelineResult,
} from "../src/runtime/debugEnvelope.ts";

const plannerParseResult = parsePlannerOutput({
  turn_type: "booking",
  confidence: "high",
  tools_requested: ["kb.search", "booking.confirm"],
  reply_strategy: "confirm_booking",
  booking_action: "confirm",
  explicit_patient_confirmation: true,
  booking_request: {
    service: "cleaning",
    preferred_date_text: "tomorrow",
  },
});

const pipelineResult = runRuntimeTurnPipeline({
  raw_planner_output: {
    turn_type: "booking",
    confidence: "high",
    tools_requested: ["kb.search", "booking.confirm"],
    reply_strategy: "confirm_booking",
    booking_action: "confirm",
    explicit_patient_confirmation: true,
  },
  truth_input: {
    active_hold: {
      id: "hold_1",
      expires_at: "2030-01-01T00:00:00.000Z",
      contact_id: "contact_1",
      case_id: "case_1",
    },
    current_contact_id: "contact_1",
    current_case_id: "case_1",
    now: new Date("2026-01-01T00:00:00.000Z"),
  },
  backend_events: ["booking.confirm.success"],
});

test("buildRuntimeDebugEnvelope creates required v1 envelope", () => {
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_1",
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
  });

  assert.equal(envelope.version, "runtime_debug_envelope_v1");
  assert.equal(envelope.trace_id, "trace_1");
  assert.equal(typeof envelope.created_at, "string");
});

test("created_at Date is converted to ISO string", () => {
  const createdAt = new Date("2026-05-20T10:11:12.000Z");
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_2",
    created_at: createdAt,
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
  });

  assert.equal(envelope.created_at, "2026-05-20T10:11:12.000Z");
});

test("missing optional arrays default to []", () => {
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_3",
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
  });

  assert.deepEqual(envelope.tool_results, []);
  assert.deepEqual(envelope.side_effects, []);
});

test("envelope copies planner parse errors and warnings", () => {
  const malformed = parsePlannerOutput({ tools_requested: ["kb.search", 12], confidence: "wrong" });
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_4",
    planner_parse_result: malformed,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
  });

  assert.equal(envelope.planner_parse_ok, true);
  assert.equal(envelope.planner_parse_errors.length, 0);
  assert.match(envelope.planner_parse_warnings.join("\n"), /invalid confidence/);
  assert.match(envelope.planner_parse_warnings.join("\n"), /non-string tool name ignored/);
});

test("envelope copies tools_requested/tools_allowed/tools_denied", () => {
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_5",
    planner_parse_result: pipelineResult.planner_parse_result,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
  });

  assert.deepEqual(envelope.tools_requested, pipelineResult.planner_parse_result.planner.tools_requested);
  assert.deepEqual(envelope.tools_allowed, pipelineResult.policy_result.tools_allowed);
  assert.deepEqual(envelope.tools_denied, pipelineResult.policy_result.tools_denied);
});

test("envelope includes truth_snapshot", () => {
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_6",
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
  });

  assert.deepEqual(envelope.truth_snapshot, pipelineResult.truth_snapshot);
});

test("envelope includes tool_results", () => {
  const toolResults = [{ tool: "kb.search", status: "not_implemented", data: null }] as const;
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_7",
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
    tool_results: [...toolResults],
  });

  assert.deepEqual(envelope.tool_results, toolResults);
});

test("envelope includes side_effects", () => {
  const sideEffects = [{ type: "admin.notify", eligible: true }] as const;
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_8",
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
    side_effects: [...sideEffects],
  });

  assert.deepEqual(envelope.side_effects, sideEffects);
});

test("envelope includes runtime_error when provided", () => {
  const envelope = buildRuntimeDebugEnvelope({
    trace_id: "trace_9",
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
    runtime_error: {
      code: "pipeline_error",
      message: "synthetic",
      retryable: false,
    },
  });

  assert.deepEqual(envelope.runtime_error, {
    code: "pipeline_error",
    message: "synthetic",
    retryable: false,
  });
});

test("envelope does not require or include raw user message text", () => {
  const envelope = buildRuntimeDebugEnvelope({
    planner_parse_result: plannerParseResult,
    truth_snapshot: pipelineResult.truth_snapshot,
    policy_result: pipelineResult.policy_result,
  });

  assert.equal(envelope.trace_id, "trace_missing");
  assert.equal("raw_user_message" in envelope, false);
  assert.equal("user_text" in envelope, false);
});

test("builder is pure and does not import DB/OpenAI/calendar/n8n/Telegram modules", async () => {
  const source = await readFile(new URL("../src/runtime/debugEnvelope.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /supabase|postgres|openai|calendar|n8n|telegram/i);
});

test("envelope can be built from runtime pipeline result plus executor results", () => {
  const toolResults = [{ tool: "kb.search", status: "not_implemented", data: null }];
  const envelope = buildRuntimeDebugEnvelopeFromPipelineResult({
    trace_id: "trace_10",
    pipeline_result: pipelineResult,
    tool_results: toolResults,
    latency_ms: 42,
  });

  assert.deepEqual(envelope.planner_output, pipelineResult.planner);
  assert.deepEqual(envelope.tool_results, toolResults);
  assert.equal(envelope.latency_ms, 42);
  assert.deepEqual(envelope.side_effects, pipelineResult.side_effects);
});

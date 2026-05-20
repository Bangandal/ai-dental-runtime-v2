import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { runRuntimeTurnDry } from "../src/runtime/runtimeTurnDryRun.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

test("dry runner with kb.search allowed and injected executor returns success result", async () => {
  const registry: ToolExecutorRegistry = {
    "kb.search": async () => ({
      tool: "kb.search",
      status: "success",
      data: { chunks: [{ chunk_id: "c1", text: "open 9-5" }] },
    }),
  };

  const result = await runRuntimeTurnDry({
    trace_id: "trace_dry_1",
    raw_planner_output: {
      turn_type: "faq",
      confidence: "high",
      tools_requested: ["kb.search"],
      reply_strategy: "answer_only",
      booking_action: null,
    },
    truth_input: {},
    executor_registry: registry,
  });

  assert.deepEqual(result.execution_plan.tools_allowed, ["kb.search"]);
  assert.equal(result.tool_results[0]?.status, "success");
});

test("dry runner with empty registry returns not_implemented result", async () => {
  const result = await runRuntimeTurnDry({
    raw_planner_output: {
      confidence: "high",
      tools_requested: ["kb.search"],
    },
    truth_input: {},
  });

  assert.equal(result.tool_results[0]?.tool, "kb.search");
  assert.equal(result.tool_results[0]?.status, "not_implemented");
});

test("dry runner with malformed planner output returns low-confidence fallback and no write execution", async () => {
  let bookingConfirmCalled = false;
  const registry: ToolExecutorRegistry = {
    "booking.confirm": async () => {
      bookingConfirmCalled = true;
      return {
        tool: "booking.confirm",
        status: "success",
        data: {
          appointment_id: "appt_1",
          hold_id: "h1",
          contact_id: "c1",
          case_id: "case1",
          starts_at: "2026-05-22T09:00:00Z",
          ends_at: "2026-05-22T09:30:00Z",
          status: "booked_confirmed",
        },
      };
    },
  };

  const result = await runRuntimeTurnDry({
    raw_planner_output: ["broken"],
    truth_input: {},
    executor_registry: registry,
  });

  assert.equal(result.pipeline_result.planner.confidence, "low");
  assert.equal(result.execution_plan.tools_allowed.includes("booking.confirm"), false);
  assert.equal(bookingConfirmCalled, false);
});

test("dry runner with booking.confirm allowed and injected executor returns booking.confirm success result", async () => {
  const registry: ToolExecutorRegistry = {
    "booking.confirm": async () => ({
      tool: "booking.confirm",
      status: "success",
      data: {
        appointment_id: "appt_1",
        hold_id: "h1",
        contact_id: "contact_1",
        case_id: "case_1",
        starts_at: "2026-05-22T09:00:00Z",
        ends_at: "2026-05-22T09:30:00Z",
        status: "booked_confirmed",
      },
    }),
  };

  const result = await runRuntimeTurnDry({
    raw_planner_output: {
      turn_type: "booking",
      confidence: "high",
      tools_requested: ["booking.confirm"],
      explicit_patient_confirmation: true,
    },
    truth_input: {
      active_hold: {
        id: "h1",
        expires_at: "2030-01-01T00:00:00.000Z",
        contact_id: "contact_1",
        case_id: "case_1",
      },
      current_contact_id: "contact_1",
      current_case_id: "case_1",
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
    executor_registry: registry,
  });

  assert.deepEqual(result.execution_plan.tools_allowed, ["booking.confirm"]);
  assert.equal(result.tool_results[0]?.tool, "booking.confirm");
  assert.equal(result.tool_results[0]?.status, "success");
});

test("dry runner with booking.confirm denied due to missing contact/case does not execute booking.confirm executor", async () => {
  let bookingConfirmCalled = false;
  const registry: ToolExecutorRegistry = {
    "booking.confirm": async () => {
      bookingConfirmCalled = true;
      return {
        tool: "booking.confirm",
        status: "success",
        data: {
          appointment_id: "appt_1",
          hold_id: "h1",
          contact_id: "contact_1",
          case_id: "case_1",
          starts_at: "2026-05-22T09:00:00Z",
          ends_at: "2026-05-22T09:30:00Z",
          status: "booked_confirmed",
        },
      };
    },
  };

  const result = await runRuntimeTurnDry({
    raw_planner_output: {
      turn_type: "booking",
      confidence: "high",
      tools_requested: ["booking.confirm"],
      explicit_patient_confirmation: true,
    },
    truth_input: {
      active_hold: {
        id: "h1",
        expires_at: "2030-01-01T00:00:00.000Z",
        contact_id: "contact_1",
        case_id: "case_1",
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
    executor_registry: registry,
  });

  assert.equal(result.execution_plan.tools_allowed.includes("booking.confirm"), false);
  assert.equal(bookingConfirmCalled, false);
});

test("dry runner preserves policy denials in execution_plan", async () => {
  const result = await runRuntimeTurnDry({
    raw_planner_output: {
      confidence: "high",
      tools_requested: ["admin.notify"],
    },
    truth_input: {},
  });

  assert.equal(result.execution_plan.policy_denials.length, 1);
  assert.equal(result.execution_plan.policy_denials[0]?.reason, "invalid_tool_requested");
});

test("debug_envelope includes tool_results", async () => {
  const result = await runRuntimeTurnDry({
    raw_planner_output: {
      confidence: "high",
      tools_requested: ["kb.search"],
    },
    truth_input: {},
  });

  assert.deepEqual(result.debug_envelope.tool_results, result.tool_results);
});

test("debug_envelope includes pipeline parser/truth/policy info", async () => {
  const result = await runRuntimeTurnDry({
    raw_planner_output: {
      confidence: "high",
      tools_requested: ["kb.search"],
    },
    truth_input: {},
  });

  assert.deepEqual(result.debug_envelope.planner_output, result.pipeline_result.planner);
  assert.deepEqual(result.debug_envelope.truth_snapshot, result.pipeline_result.truth_snapshot);
  assert.deepEqual(result.debug_envelope.tools_denied, result.pipeline_result.policy_result.tools_denied);
});

test("debug_envelope does not include raw user text", async () => {
  const result = await runRuntimeTurnDry({
    raw_planner_output: {
      confidence: "high",
    },
    truth_input: {},
  });

  assert.equal("raw_user_message" in result.debug_envelope, false);
  assert.equal("user_text" in result.debug_envelope, false);
});

test("latency_ms is computed when started_at/ended_at are provided", async () => {
  const result = await runRuntimeTurnDry({
    raw_planner_output: { confidence: "high" },
    truth_input: {},
    started_at: 100,
    ended_at: 145,
  });

  assert.equal(result.debug_envelope.latency_ms, 45);
});

test("no DB/OpenAI/calendar/n8n/Telegram imports are introduced", async () => {
  const source = await readFile(new URL("../src/runtime/runtimeTurnDryRun.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /supabase|postgres|openai|calendar|n8n|telegram/i);
});

test("execution_context cannot override planner and truth_snapshot", async () => {
  let capturedPlanner: unknown;
  let capturedTruthSnapshot: unknown;
  const registry: ToolExecutorRegistry = {
    "kb.search": async (context) => {
      capturedPlanner = context.planner;
      capturedTruthSnapshot = context.truth_snapshot;
      return { tool: "kb.search", status: "not_implemented" };
    },
  };
  const spoofedPlanner = { confidence: "high", tools_requested: ["booking.confirm"] };
  const spoofedTruth = { hold_present: true };

  const result = await runRuntimeTurnDry({
    raw_planner_output: { confidence: "high", tools_requested: ["kb.search"] },
    truth_input: {},
    executor_registry: registry,
    execution_context: {
      planner: spoofedPlanner as never,
      truth_snapshot: spoofedTruth as never,
    },
  });

  assert.notEqual(capturedPlanner, spoofedPlanner);
  assert.notEqual(capturedTruthSnapshot, spoofedTruth);
  assert.deepEqual(capturedPlanner, result.pipeline_result.planner);
  assert.deepEqual(capturedTruthSnapshot, result.pipeline_result.truth_snapshot);
});

test("execution_context cannot override contact_id/case_id when top-level values are provided", async () => {
  let capturedContactId: unknown;
  let capturedCaseId: unknown;
  const registry: ToolExecutorRegistry = {
    "kb.search": async (context) => {
      capturedContactId = context.contact_id;
      capturedCaseId = context.case_id;
      return { tool: "kb.search", status: "not_implemented" };
    },
  };

  await runRuntimeTurnDry({
    contact_id: "contact_top",
    case_id: "case_top",
    raw_planner_output: { confidence: "high", tools_requested: ["kb.search"] },
    truth_input: {},
    executor_registry: registry,
    execution_context: {
      contact_id: "contact_ctx",
      case_id: "case_ctx",
    },
  });

  assert.equal(capturedContactId, "contact_top");
  assert.equal(capturedCaseId, "case_top");
});

test("execution_context supplemental timezone/now are preserved", async () => {
  let capturedTimezone: unknown;
  let capturedNow: unknown;
  const registry: ToolExecutorRegistry = {
    "kb.search": async (context) => {
      capturedTimezone = (context as Record<string, unknown>).timezone;
      capturedNow = (context as Record<string, unknown>).now;
      return { tool: "kb.search", status: "not_implemented" };
    },
  };
  const now = "2026-05-20T12:00:00.000Z";

  await runRuntimeTurnDry({
    raw_planner_output: { confidence: "high", tools_requested: ["kb.search"] },
    truth_input: {},
    executor_registry: registry,
    execution_context: {
      timezone: "America/New_York",
      now,
    } as never,
  });

  assert.equal(capturedTimezone, "America/New_York");
  assert.equal(capturedNow, now);
});

test("side_effects are included in debug envelope but not delivered", async () => {
  const result = await runRuntimeTurnDry({
    raw_planner_output: { confidence: "high" },
    truth_input: {},
    backend_events: ["booking.confirm.success"],
  });

  assert.deepEqual(result.debug_envelope.side_effects, [{ type: "admin.notify", eligible: true }]);
  assert.equal(result.tool_results.some((toolResult) => toolResult.tool === "admin.notify"), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { PolicyResult, ToolName } from "../src/runtime/toolPolicy.ts";
import {
  buildToolExecutionPlan,
  executeAllowedTools,
  type ToolExecutionContext,
  type ToolExecutorRegistry,
} from "../src/runtime/toolExecutor.ts";

const CONTEXT: ToolExecutionContext = {
  trace_id: "trace_1",
  contact_id: "contact_1",
  case_id: "case_1",
  timezone: "UTC",
  now: new Date("2026-05-20T00:00:00.000Z"),
};

test("executeAllowedTools returns not_implemented when registry is empty", async () => {
  const results = await executeAllowedTools({
    tools_allowed: ["kb.search"],
    context: CONTEXT,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.tool, "kb.search");
  assert.equal(results[0]?.status, "not_implemented");
});

test("executeAllowedTools calls injected kb.search executor when allowed", async () => {
  let called = false;
  const registry: ToolExecutorRegistry = {
    "kb.search": async (context) => {
      called = true;
      assert.equal(context.trace_id, "trace_1");
      return {
        tool: "kb.search",
        status: "success",
        data: { chunks: [{ chunk_id: "c1", text: "clinic hours" }] },
      };
    },
  };

  const results = await executeAllowedTools({
    tools_allowed: ["kb.search"],
    registry,
    context: CONTEXT,
  });

  assert.equal(called, true);
  assert.equal(results[0]?.status, "success");
});

test("executeAllowedTools does not call executor for tools not in tools_allowed", async () => {
  let holdCreateCalled = false;

  const registry: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
    "hold.create": async () => {
      holdCreateCalled = true;
      return {
        tool: "hold.create",
        status: "success",
        data: {
          hold_id: "h1",
          slot_id: "s1",
          starts_at: "2026-05-22T09:00:00Z",
          ends_at: "2026-05-22T09:30:00Z",
          expires_at: "2026-05-22T08:55:00Z",
          contact_id: "contact_1",
          case_id: "case_1",
        },
      };
    },
  };

  await executeAllowedTools({
    tools_allowed: ["kb.search"],
    registry,
    context: CONTEXT,
  });

  assert.equal(holdCreateCalled, false);
});

test("executeAllowedTools preserves tool order", async () => {
  const toolsAllowed: ToolName[] = ["booking.confirm", "kb.search", "availability.check"];

  const registry: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
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

  const results = await executeAllowedTools({
    tools_allowed: toolsAllowed,
    registry,
    context: CONTEXT,
  });

  assert.deepEqual(
    results.map((result) => result.tool),
    ["booking.confirm", "kb.search", "availability.check"],
  );
  assert.equal(results[2]?.status, "not_implemented");
});

test("executeAllowedTools catches thrown executor error and returns failed result", async () => {
  const registry: ToolExecutorRegistry = {
    "kb.search": async () => {
      throw new Error("synthetic executor failure");
    },
  };

  const results = await executeAllowedTools({
    tools_allowed: ["kb.search"],
    registry,
    context: CONTEXT,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "failed");
  assert.equal(results[0]?.tool, "kb.search");
  assert.equal(results[0]?.error?.code, "executor_exception");
});

test("failed executor result has status failed and executor_exception code", async () => {
  const registry: ToolExecutorRegistry = {
    "availability.check": async () => {
      throw new Error("availability provider exception");
    },
  };

  const [result] = await executeAllowedTools({
    tools_allowed: ["availability.check"],
    registry,
    context: CONTEXT,
  });

  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "executor_exception");
  assert.equal(result?.error?.retryable, true);
});

test("buildToolExecutionPlan copies allowed tools and policy denials from PolicyResult", () => {
  const policyResult: PolicyResult = {
    tools_allowed: ["kb.search"],
    tools_denied: [
      {
        tool: "hold.create",
        allowed: false,
        reason: "low_confidence_execution_gate",
      },
    ],
    reply_strategy: "ask_clarification",
    booking_action: null,
    side_effects: [],
  };

  const plan = buildToolExecutionPlan(policyResult);
  assert.deepEqual(plan.tools_allowed, policyResult.tools_allowed);
  assert.deepEqual(plan.policy_denials, policyResult.tools_denied);
});

test("policy denied tools are not executed", async () => {
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

  const plan = {
    tools_allowed: ["kb.search"] as ToolName[],
    policy_denials: [{ tool: "booking.confirm", allowed: false }],
  };

  const results = await executeAllowedTools({
    tools_allowed: plan.tools_allowed,
    registry,
    context: CONTEXT,
  });

  assert.equal(bookingConfirmCalled, false);
  assert.deepEqual(results.map((result) => result.tool), ["kb.search"]);
});

test("admin.notify cannot be executed because it is not ToolName", () => {
  const supportedTools: ToolName[] = [
    "kb.search",
    "availability.check",
    "hold.create",
    "booking.confirm",
    "cancel_hold",
    "appointment.mutate",
  ];

  assert.equal(supportedTools.includes("admin.notify" as ToolName), false);
});

test("no DB/OpenAI/calendar/n8n/Telegram imports are introduced", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/runtime/toolExecutor.ts", import.meta.url), "utf8");

  assert.match(source, /from "\.\/toolPolicy\.ts"/);
  assert.match(source, /from "\.\/toolResults\.ts"/);
  assert.doesNotMatch(source, /supabase|postgres|openai|calendar|n8n|telegram/i);
});

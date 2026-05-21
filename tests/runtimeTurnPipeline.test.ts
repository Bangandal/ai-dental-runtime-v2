import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeTurnPipeline } from "../src/runtime/runtimeTurnPipeline.ts";

test("valid kb.search planner output flows through and allows kb.search", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      turn_type: "faq",
      confidence: "high",
      tools_requested: ["kb.search"],
      reply_strategy: "answer_only",
      booking_action: null,
    },
    truth_input: {},
  });

  assert.equal(result.planner_parse_result.ok, true);
  assert.deepEqual(result.policy_result.tools_allowed, ["kb.search"]);
});

test("malformed planner output returns low-confidence fallback and no allowed write tools", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: ["bad"],
    truth_input: {},
  });

  assert.equal(result.planner_parse_result.ok, false);
  assert.equal(result.planner.confidence, "low");
  assert.equal(result.policy_result.tools_allowed.includes("hold.create"), false);
  assert.equal(result.policy_result.tools_allowed.includes("booking.confirm"), false);
});

test("high-confidence booking.confirm with matching hold/contact/case is allowed", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      confidence: "high",
      turn_type: "booking",
      tools_requested: ["booking.confirm"],
      explicit_patient_confirmation: true,
    },
    truth_input: {
      active_hold: {
        id: "h1",
        expires_at: "2030-01-01T00:00:00.000Z",
        contact_id: "c1",
        case_id: "case1",
      },
      current_contact_id: "c1",
      current_case_id: "case1",
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  assert.deepEqual(result.policy_result.tools_allowed, ["booking.confirm"]);
});

test("high-confidence booking.confirm with missing current contact/case is denied", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      confidence: "high",
      turn_type: "booking",
      tools_requested: ["booking.confirm"],
      explicit_patient_confirmation: true,
    },
    truth_input: {
      active_hold: {
        id: "h1",
        expires_at: "2030-01-01T00:00:00.000Z",
        contact_id: "c1",
        case_id: "case1",
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  assert.equal(result.policy_result.tools_allowed.length, 0);
  assert.equal(result.policy_result.tools_denied[0]?.reason, "booking_confirm_contact_case_mismatch");
});

test("low-confidence hold.create is denied by policy", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      confidence: "low",
      tools_requested: ["hold.create"],
    },
    truth_input: {
      availability_result: { slots: [{ when: "10:00" }] },
      proposed_slot: { when: "10:00" },
      service_interest: "cleaning",
    },
  });

  assert.equal(result.policy_result.tools_allowed.length, 0);
  assert.equal(result.policy_result.tools_denied[0]?.reason, "low_confidence_execution_gate");
});

test("reschedule planner action is parsed but unimplemented tools are denied", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      turn_type: "reschedule",
      booking_action: "reschedule_confirm",
      tools_requested: ["reschedule.confirm"],
    },
    truth_input: {},
  });

  assert.equal(result.planner.booking_action, "reschedule_confirm");
  assert.equal(result.policy_result.tools_denied[0]?.reason, "invalid_tool_requested");
});

test("backend booking.confirm.success can derive admin.notify side effect", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      confidence: "high",
    },
    truth_input: {},
    backend_events: ["booking.confirm.success"],
  });

  assert.deepEqual(result.side_effects, [{ type: "admin.notify", eligible: true }]);
  assert.deepEqual(result.policy_result.side_effects, []);
});

test("runtime pipeline side_effects come from deriveRuntimeSideEffects, not PolicyResult.side_effects", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      confidence: "high",
      tools_requested: ["kb.search"],
    },
    truth_input: {},
    backend_events: ["booking.confirm.success"],
  });

  assert.deepEqual(result.policy_result.side_effects, []);
  assert.deepEqual(result.side_effects, [{ type: "admin.notify", eligible: true }]);
});

test("no backend events produce no side effects", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: { confidence: "high" },
    truth_input: {},
  });

  assert.deepEqual(result.side_effects, []);
});

test("debug_summary includes parse diagnostics and policy allow/deny info", () => {
  const result = runRuntimeTurnPipeline({
    raw_planner_output: {
      confidence: "certain",
      turn_type: "weird_turn",
      tools_requested: ["kb.search", 5, "admin.notify"],
    },
    truth_input: {},
  });

  assert.equal(result.debug_summary.parse_ok, true);
  assert.match(result.debug_summary.parse_warnings.join("\n"), /invalid confidence/);
  assert.match(result.debug_summary.parse_warnings.join("\n"), /invalid turn_type/);
  assert.deepEqual(result.debug_summary.tools_allowed, ["kb.search"]);
  assert.equal(result.debug_summary.tools_denied[0]?.reason, "invalid_tool_requested");
});

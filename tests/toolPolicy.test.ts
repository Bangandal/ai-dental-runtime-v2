import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToolPolicy,
  deriveRuntimeSideEffects,
  type PlannerOutput,
  type TruthSnapshot,
} from "../src/runtime/toolPolicy.ts";

const baseTruth: TruthSnapshot = {
  active_hold_exists: true,
  hold_not_expired: true,
  contact_case_match: true,
  contradiction_in_turn: false,
};

const basePlanner: PlannerOutput = {
  confidence: "high",
  tools_requested: [],
  reply_strategy: "answer_only",
  booking_action: null,
  explicit_patient_confirmation: false,
};

test("low confidence + booking.confirm is denied with gate reason", () => {
  const result = applyToolPolicy(
    { ...basePlanner, confidence: "low", tools_requested: ["booking.confirm"], booking_action: "confirm" },
    baseTruth,
  );

  assert.equal(result.tools_allowed.length, 0);
  assert.deepEqual(result.tools_denied[0], {
    tool: "booking.confirm",
    allowed: false,
    reason: "low_confidence_execution_gate",
  });
  assert.equal(result.reply_strategy, "ask_clarification");
  assert.equal(result.booking_action, null);
});

test("low confidence + hold.create is denied", () => {
  const result = applyToolPolicy(
    {
      ...basePlanner,
      confidence: "low",
      tools_requested: ["hold.create"],
      booking_action: "create_hold",
      booking_request: { service: "cleaning", preferred_date_text: "tomorrow", preferred_time_text: "evening" },
    },
    baseTruth,
  );

  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "low_confidence_execution_gate");
});

test("admin.notify is not accepted as a runtime tool", () => {
  const result = applyToolPolicy(
    { ...basePlanner, tools_requested: ["admin.notify" as never] },
    baseTruth,
  );

  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "invalid_tool_requested");
});

test("low confidence suppresses eligible notification side effects", () => {
  const effects = deriveRuntimeSideEffects("low", ["booking.confirm.success"]);
  assert.deepEqual(effects, [{ type: "admin.notify", eligible: false, reason: "low_confidence_execution_gate" }]);
});

test("low confidence + clarification response is allowed", () => {
  const result = applyToolPolicy(
    {
      ...basePlanner,
      confidence: "low",
      tools_requested: ["kb.search"],
      reply_strategy: "ask_clarification",
    },
    baseTruth,
  );

  assert.deepEqual(result.tools_allowed, ["kb.search"]);
  assert.equal(result.reply_strategy, "ask_clarification");
});

test("high confidence + active hold + explicit confirmation can pass booking.confirm", () => {
  const result = applyToolPolicy(
    {
      ...basePlanner,
      confidence: "high",
      tools_requested: ["booking.confirm"],
      explicit_patient_confirmation: true,
    },
    baseTruth,
  );

  assert.deepEqual(result.tools_allowed, ["booking.confirm"]);
  assert.equal(result.tools_denied.length, 0);
});

test("medium confidence is denied for booking.confirm", () => {
  const result = applyToolPolicy(
    {
      ...basePlanner,
      confidence: "medium",
      tools_requested: ["booking.confirm"],
      explicit_patient_confirmation: true,
    },
    baseTruth,
  );

  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "booking_confirm_requires_high_confidence");
});

test("booking.confirm success can create eligible admin notification side effect via backend event", () => {
  const effects = deriveRuntimeSideEffects("high", ["booking.confirm.success"]);
  assert.deepEqual(effects, [{ type: "admin.notify", eligible: true }]);
});

test("faq soft interest does not create admin notification side effect", () => {
  const effects = deriveRuntimeSideEffects("high", ["faq.soft_interest"]);
  assert.deepEqual(effects, []);
});

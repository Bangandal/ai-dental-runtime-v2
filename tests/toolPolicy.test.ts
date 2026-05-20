import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_POLICY_MATRIX,
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
  availability_result_exists: true,
  proposed_slot_exists: true,
  service_known: true,
  explicit_slot_rejection: false,
  explicit_cancellation_request: false,
  scheduling_intent_present: true,
  date_or_time_present: true,
};

const basePlanner: PlannerOutput = {
  turn_type: "booking",
  confidence: "high",
  tools_requested: [],
  reply_strategy: "answer_only",
  booking_action: null,
  explicit_patient_confirmation: false,
};

test("tool policy matrix has expected classifications", () => {
  assert.equal(TOOL_POLICY_MATRIX["kb.search"].class, "read");
  assert.equal(TOOL_POLICY_MATRIX["availability.check"].class, "read");
  assert.equal(TOOL_POLICY_MATRIX["hold.create"].class, "write");
  assert.equal(TOOL_POLICY_MATRIX["booking.confirm"].class, "write");
  assert.equal(TOOL_POLICY_MATRIX["cancel_hold"].class, "destructive");
  assert.equal(TOOL_POLICY_MATRIX["appointment.mutate"].class, "destructive");
});

test("kb.search allowed as read tool", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["kb.search"] }, baseTruth);
  assert.deepEqual(result.tools_allowed, ["kb.search"]);
  assert.equal(result.tools_denied.length, 0);
});

test("low confidence + kb.search is allowed as read tool", () => {
  const result = applyToolPolicy(
    { ...basePlanner, confidence: "low", tools_requested: ["kb.search"] },
    baseTruth,
  );
  assert.deepEqual(result.tools_allowed, ["kb.search"]);
  assert.equal(result.tools_denied.length, 0);
});

test("availability.check denied on low confidence", () => {
  const result = applyToolPolicy(
    { ...basePlanner, confidence: "low", tools_requested: ["availability.check"] },
    baseTruth,
  );
  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "availability_check_requires_confidence");
});

test("availability.check denied on contradiction", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["availability.check"] }, { ...baseTruth, contradiction_in_turn: true });
  assert.equal(result.tools_denied[0]?.reason, "contradiction_in_turn");
});

test("availability.check denied without scheduling intent", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["availability.check"] }, { ...baseTruth, scheduling_intent_present: false });
  assert.equal(result.tools_denied[0]?.reason, "scheduling_intent_missing");
});

test("availability.check denied without date/time preference", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["availability.check"] }, { ...baseTruth, date_or_time_present: false });
  assert.equal(result.tools_denied[0]?.reason, "date_or_time_missing");
});

test("hold.create denied without availability result", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["hold.create"], confidence: "medium" }, { ...baseTruth, availability_result_exists: false });
  assert.equal(result.tools_denied[0]?.reason, "availability_result_required");
});

test("hold.create denied without proposed slot", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["hold.create"], confidence: "medium" }, { ...baseTruth, proposed_slot_exists: false });
  assert.equal(result.tools_denied[0]?.reason, "proposed_slot_required");
});

test("hold.create denied without service", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["hold.create"], confidence: "medium" }, { ...baseTruth, service_known: false });
  assert.equal(result.tools_denied[0]?.reason, "service_required");
});

test("hold.create allowed with medium/high confidence and required facts", () => {
  const medium = applyToolPolicy({ ...basePlanner, confidence: "medium", tools_requested: ["hold.create"] }, baseTruth);
  assert.deepEqual(medium.tools_allowed, ["hold.create"]);

  const high = applyToolPolicy({ ...basePlanner, confidence: "high", tools_requested: ["hold.create"] }, baseTruth);
  assert.deepEqual(high.tools_allowed, ["hold.create"]);
});

test("low confidence + hold.create is denied with gate reason", () => {
  const result = applyToolPolicy(
    { ...basePlanner, confidence: "low", tools_requested: ["hold.create"] },
    baseTruth,
  );
  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "low_confidence_execution_gate");
});

test("low confidence + booking.confirm is denied with gate reason", () => {
  const result = applyToolPolicy(
    {
      ...basePlanner,
      confidence: "low",
      tools_requested: ["booking.confirm"],
      explicit_patient_confirmation: true,
    },
    baseTruth,
  );
  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "low_confidence_execution_gate");
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

test("cancel_hold denied on low confidence", () => {
  const result = applyToolPolicy({ ...basePlanner, confidence: "low", tools_requested: ["cancel_hold"] }, baseTruth);
  assert.equal(result.tools_denied[0]?.reason, "low_confidence_execution_gate");
});

test("cancel_hold denied without active hold", () => {
  const result = applyToolPolicy({ ...basePlanner, confidence: "medium", tools_requested: ["cancel_hold"] }, { ...baseTruth, active_hold_exists: false, explicit_cancellation_request: true });
  assert.equal(result.tools_denied[0]?.reason, "cancel_hold_requires_active_hold");
});

test("cancel_hold denied without explicit rejection/cancellation", () => {
  const result = applyToolPolicy({ ...basePlanner, confidence: "medium", tools_requested: ["cancel_hold"] }, baseTruth);
  assert.equal(result.tools_denied[0]?.reason, "cancel_hold_requires_explicit_rejection_or_cancellation");
});

test("cancel_hold allowed with active hold + explicit rejection/cancellation", () => {
  const byRejection = applyToolPolicy({ ...basePlanner, confidence: "medium", tools_requested: ["cancel_hold"] }, { ...baseTruth, explicit_slot_rejection: true });
  assert.deepEqual(byRejection.tools_allowed, ["cancel_hold"]);

  const byCancelRequest = applyToolPolicy({ ...basePlanner, confidence: "high", tools_requested: ["cancel_hold"] }, { ...baseTruth, explicit_cancellation_request: true });
  assert.deepEqual(byCancelRequest.tools_allowed, ["cancel_hold"]);
});

test("appointment.mutate denied by default as not implemented", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["appointment.mutate"] }, baseTruth);
  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "appointment_mutation_not_implemented");
});

test("low confidence + appointment.mutate is denied with gate reason", () => {
  const result = applyToolPolicy(
    { ...basePlanner, confidence: "low", tools_requested: ["appointment.mutate"] },
    baseTruth,
  );
  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "low_confidence_execution_gate");
});

test("admin.notify is not accepted as a runtime tool", () => {
  const result = applyToolPolicy(
    { ...basePlanner, tools_requested: ["admin.notify"] },
    baseTruth,
  );

  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "invalid_tool_requested");
});

test("invalid tool still denied with invalid_tool_requested", () => {
  const result = applyToolPolicy({ ...basePlanner, tools_requested: ["bogus.tool"] }, baseTruth);
  assert.equal(result.tools_denied[0]?.reason, "invalid_tool_requested");
});

test("low confidence suppresses eligible notification side effects", () => {
  const effects = deriveRuntimeSideEffects("low", ["booking.confirm.success"]);
  assert.deepEqual(effects, [{ type: "admin.notify", eligible: false, reason: "low_confidence_execution_gate" }]);
});

test("booking.confirm success can create eligible admin notification side effect via backend event", () => {
  const effects = deriveRuntimeSideEffects("high", ["booking.confirm.success"]);
  assert.deepEqual(effects, [{ type: "admin.notify", eligible: true }]);
});

test("faq soft interest does not create admin notification side effect", () => {
  const effects = deriveRuntimeSideEffects("high", ["faq.soft_interest"]);
  assert.deepEqual(effects, []);
});

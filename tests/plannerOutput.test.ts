import assert from "node:assert/strict";
import test from "node:test";

import { parsePlannerOutput } from "../src/runtime/plannerOutput.ts";
import { applyToolPolicy, type TruthSnapshot } from "../src/runtime/toolPolicy.ts";

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

test("valid planner output parses ok", () => {
  const result = parsePlannerOutput({
    turn_type: "booking",
    confidence: "high",
    tools_requested: ["kb.search", "admin.notify"],
    reply_strategy: "answer_only",
    booking_action: "check_availability",
    explicit_patient_confirmation: true,
    booking_request: {
      service: "cleaning",
      preferred_date_text: "next monday",
      preferred_time_text: "10am",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.planner.tools_requested, ["kb.search", "admin.notify"]);
});

test("invalid confidence becomes low", () => {
  const result = parsePlannerOutput({ confidence: "certain" });
  assert.equal(result.planner.confidence, "low");
  assert.match(result.warnings.join("\n"), /invalid confidence/);
});

test("invalid reply_strategy becomes ask_clarification", () => {
  const result = parsePlannerOutput({ reply_strategy: "whatever" });
  assert.equal(result.planner.reply_strategy, "ask_clarification");
});

test("invalid booking_action becomes null", () => {
  const result = parsePlannerOutput({ booking_action: "book_it" });
  assert.equal(result.planner.booking_action, null);
});

test("booking_action=reschedule_check parses ok", () => {
  const result = parsePlannerOutput({ booking_action: "reschedule_check" });
  assert.equal(result.planner.booking_action, "reschedule_check");
});

test("booking_action=reschedule_confirm parses ok", () => {
  const result = parsePlannerOutput({ booking_action: "reschedule_confirm" });
  assert.equal(result.planner.booking_action, "reschedule_confirm");
});

test("booking_action=cancel_request parses ok", () => {
  const result = parsePlannerOutput({ booking_action: "cancel_request" });
  assert.equal(result.planner.booking_action, "cancel_request");
});

test("tools_requested accepts raw strings and non-string tools are ignored", () => {
  const result = parsePlannerOutput({ tools_requested: ["kb.search", 5, true, "admin.notify"] });
  assert.deepEqual(result.planner.tools_requested, ["kb.search", "admin.notify"]);
  assert.match(result.warnings.join("\n"), /non-string tool name ignored/);
});

test("malformed raw object returns safe fallback", () => {
  const result = parsePlannerOutput(["not", "an", "object"]);
  assert.equal(result.ok, false);
  assert.equal(result.planner.confidence, "low");
  assert.deepEqual(result.planner.tools_requested, []);
  assert.equal(result.planner.reply_strategy, "ask_clarification");
  assert.equal(result.planner.turn_type, "unknown");
});

test("null and undefined return safe fallback", () => {
  const fromNull = parsePlannerOutput(null);
  assert.equal(fromNull.ok, false);
  assert.equal(fromNull.planner.confidence, "low");

  const fromUndefined = parsePlannerOutput(undefined);
  assert.equal(fromUndefined.ok, false);
  assert.equal(fromUndefined.planner.confidence, "low");
});

test("parser output can be passed into applyToolPolicy", () => {
  const parsed = parsePlannerOutput({
    confidence: "high",
    tools_requested: ["kb.search"],
    reply_strategy: "answer_only",
    booking_action: null,
  });

  const result = applyToolPolicy(parsed.planner, baseTruth);
  assert.deepEqual(result.tools_allowed, ["kb.search"]);
});

test("low-confidence fallback cannot allow write tools through policy", () => {
  const parsed = parsePlannerOutput({
    confidence: "not-real",
    tools_requested: ["hold.create", "booking.confirm"],
  });

  const result = applyToolPolicy(parsed.planner, baseTruth);
  assert.equal(parsed.planner.confidence, "low");
  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "low_confidence_execution_gate");
  assert.equal(result.tools_denied[1]?.reason, "low_confidence_execution_gate");
});

test("reschedule.confirm is an unimplemented tool and appointment.cancel is now implemented", () => {
  const parsed = parsePlannerOutput({
    turn_type: "cancel",
    confidence: "high",
    booking_action: "cancel_request",
    tools_requested: ["reschedule.confirm", "appointment.cancel"],
  });

  // appointment.cancel requires explicit_cancellation_request=true in truth snapshot
  const cancelTruth = { ...baseTruth, explicit_cancellation_request: true };
  const result = applyToolPolicy(parsed.planner, cancelTruth);
  // reschedule.confirm is unknown → denied with invalid_tool_requested
  assert.equal(result.tools_denied[0]?.tool, "reschedule.confirm");
  assert.equal(result.tools_denied[0]?.reason, "invalid_tool_requested");
  // appointment.cancel is now implemented → allowed when explicit_cancellation_request=true
  assert.equal(result.tools_allowed.includes("appointment.cancel"), true);
});
test("valid turn_type=reschedule parses ok", () => {
  const result = parsePlannerOutput({ turn_type: "reschedule" });
  assert.equal(result.ok, true);
  assert.equal(result.planner.turn_type, "reschedule");
});

test("valid turn_type=cancel parses ok", () => {
  const result = parsePlannerOutput({ turn_type: "cancel" });
  assert.equal(result.ok, true);
  assert.equal(result.planner.turn_type, "cancel");
});

test("invalid turn_type becomes unknown with warning", () => {
  const result = parsePlannerOutput({ turn_type: "weird_turn" });
  assert.equal(result.planner.turn_type, "unknown");
  assert.match(result.warnings.join("\n"), /invalid turn_type/);
});

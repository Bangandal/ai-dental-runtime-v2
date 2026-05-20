import assert from "node:assert/strict";
import test from "node:test";

import { parsePlannerOutput } from "../src/runtime/plannerOutput.ts";
import { buildTruthSnapshot } from "../src/runtime/truthSnapshot.ts";
import { applyToolPolicy } from "../src/runtime/toolPolicy.ts";

test("no context produces explicit false booleans", () => {
  const truth = buildTruthSnapshot({});

  assert.deepEqual(truth, {
    active_hold_exists: false,
    hold_not_expired: false,
    contact_case_match: false,
    contradiction_in_turn: false,
    availability_result_exists: false,
    proposed_slot_exists: false,
    service_known: false,
    explicit_slot_rejection: false,
    explicit_cancellation_request: false,
    scheduling_intent_present: false,
    date_or_time_present: false,
  });
});

test("active hold with future expires_at sets hold booleans", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", expires_at: "2030-01-01T00:00:00.000Z" },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(truth.active_hold_exists, true);
  assert.equal(truth.hold_not_expired, true);
});

test("expired hold sets hold_not_expired=false", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", expires_at: "2025-01-01T00:00:00.000Z" },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(truth.active_hold_exists, true);
  assert.equal(truth.hold_not_expired, false);
});

test("active hold but no current_contact_id/current_case_id => contact_case_match=false", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", contact_id: "c1", case_id: "case1" },
  });

  assert.equal(truth.contact_case_match, false);
});

test("active hold but missing active_hold.contact_id => contact_case_match=false", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", contact_id: null, case_id: "case1" },
    current_contact_id: "c1",
    current_case_id: "case1",
  });

  assert.equal(truth.contact_case_match, false);
});

test("active hold but missing active_hold.case_id => contact_case_match=false", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", contact_id: "c1", case_id: null },
    current_contact_id: "c1",
    current_case_id: "case1",
  });

  assert.equal(truth.contact_case_match, false);
});

test("active hold with matching contact but missing current case id => contact_case_match=false", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", contact_id: "c1", case_id: "case1" },
    current_contact_id: "c1",
    current_case_id: null,
  });

  assert.equal(truth.contact_case_match, false);
});

test("active hold with matching contact/case => contact_case_match=true", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", contact_id: "c1", case_id: "case1" },
    current_contact_id: "c1",
    current_case_id: "case1",
  });

  assert.equal(truth.contact_case_match, true);
});

test("contact mismatch => contact_case_match=false", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", contact_id: "c1", case_id: "case1" },
    current_contact_id: "c2",
    current_case_id: "case1",
  });

  assert.equal(truth.contact_case_match, false);
});

test("case mismatch => contact_case_match=false", () => {
  const truth = buildTruthSnapshot({
    active_hold: { id: "hold_1", contact_id: "c1", case_id: "case1" },
    current_contact_id: "c1",
    current_case_id: "case2",
  });

  assert.equal(truth.contact_case_match, false);
});

test("availability_result with non-empty slots sets availability_result_exists=true", () => {
  const truth = buildTruthSnapshot({
    availability_result: { slots: [{ when: "10am" }] },
  });

  assert.equal(truth.availability_result_exists, true);
});

test("empty slots sets availability_result_exists=false", () => {
  const truth = buildTruthSnapshot({
    availability_result: { slots: [] },
  });

  assert.equal(truth.availability_result_exists, false);
});

test("proposed_slot object sets proposed_slot_exists=true", () => {
  const truth = buildTruthSnapshot({ proposed_slot: { when: "10am" } });
  assert.equal(truth.proposed_slot_exists, true);
});

test("service_interest sets service_known=true", () => {
  const truth = buildTruthSnapshot({ service_interest: "cleaning" });
  assert.equal(truth.service_known, true);
});

test("planner booking_request service sets service_known=true", () => {
  const planner = parsePlannerOutput({ booking_request: { service: "filling" } }).planner;
  const truth = buildTruthSnapshot({ planner });
  assert.equal(truth.service_known, true);
});

test("flags are copied into TruthSnapshot", () => {
  const truth = buildTruthSnapshot({
    current_turn_flags: {
      contradiction_in_turn: true,
      explicit_slot_rejection: true,
      explicit_cancellation_request: true,
      scheduling_intent_present: true,
      date_or_time_present: true,
    },
  });

  assert.equal(truth.contradiction_in_turn, true);
  assert.equal(truth.explicit_slot_rejection, true);
  assert.equal(truth.explicit_cancellation_request, true);
  assert.equal(truth.scheduling_intent_present, true);
  assert.equal(truth.date_or_time_present, true);
});

test("scheduling_intent_present derives from planner.turn_type=availability_request", () => {
  const planner = parsePlannerOutput({ turn_type: "availability_request" }).planner;
  const truth = buildTruthSnapshot({ planner });
  assert.equal(truth.scheduling_intent_present, true);
});

test("scheduling_intent_present derives from planner.turn_type=reschedule", () => {
  const planner = parsePlannerOutput({ turn_type: "reschedule" }).planner;
  const truth = buildTruthSnapshot({ planner });
  assert.equal(truth.scheduling_intent_present, true);
});

test("date_or_time_present derives from planner booking request date/time", () => {
  const planner = parsePlannerOutput({
    booking_request: { preferred_date_text: "next monday", preferred_time_text: null },
  }).planner;
  const truth = buildTruthSnapshot({ planner });

  assert.equal(truth.date_or_time_present, true);
});

test("builder output can be passed into applyToolPolicy", () => {
  const planner = parsePlannerOutput({
    confidence: "high",
    tools_requested: ["kb.search"],
    reply_strategy: "answer_only",
    booking_action: null,
  }).planner;

  const truth = buildTruthSnapshot({});
  const result = applyToolPolicy(planner, truth);

  assert.deepEqual(result.tools_allowed, ["kb.search"]);
});

test("hold.create allowed only when builder produces availability/proposed/service facts", () => {
  const planner = parsePlannerOutput({
    confidence: "medium",
    tools_requested: ["hold.create"],
  }).planner;

  const denied = applyToolPolicy(planner, buildTruthSnapshot({}));
  assert.equal(denied.tools_allowed.length, 0);

  const allowedTruth = buildTruthSnapshot({
    availability_result: { slots: [{ when: "10am" }] },
    proposed_slot: { when: "10am" },
    service_interest: "cleaning",
  });

  const allowed = applyToolPolicy(planner, allowedTruth);
  assert.deepEqual(allowed.tools_allowed, ["hold.create"]);
});



test("booking.confirm denied when active hold exists but contact/case ids are missing", () => {
  const planner = parsePlannerOutput({
    confidence: "high",
    tools_requested: ["booking.confirm"],
    explicit_patient_confirmation: true,
  }).planner;

  const truth = buildTruthSnapshot({
    active_hold: {
      id: "hold_1",
      expires_at: "2030-01-01T00:00:00.000Z",
      contact_id: "c1",
      case_id: "case1",
    },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  const result = applyToolPolicy(planner, truth);
  assert.equal(result.tools_allowed.length, 0);
  assert.equal(result.tools_denied[0]?.reason, "booking_confirm_contact_case_mismatch");
});

test("booking.confirm allowed only when builder produces hold/expiry/match and planner has explicit confirmation", () => {
  const plannerWithoutConfirmation = parsePlannerOutput({
    confidence: "high",
    tools_requested: ["booking.confirm"],
    explicit_patient_confirmation: false,
  }).planner;

  const plannerWithConfirmation = parsePlannerOutput({
    confidence: "high",
    tools_requested: ["booking.confirm"],
    explicit_patient_confirmation: true,
  }).planner;

  const truth = buildTruthSnapshot({
    active_hold: {
      id: "hold_1",
      expires_at: "2030-01-01T00:00:00.000Z",
      contact_id: "c1",
      case_id: "case1",
    },
    current_contact_id: "c1",
    current_case_id: "case1",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  const denied = applyToolPolicy(plannerWithoutConfirmation, truth);
  assert.equal(denied.tools_allowed.length, 0);

  const allowed = applyToolPolicy(plannerWithConfirmation, truth);
  assert.deepEqual(allowed.tools_allowed, ["booking.confirm"]);
});

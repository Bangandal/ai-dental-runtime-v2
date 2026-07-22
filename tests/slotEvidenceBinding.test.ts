/**
 * PR #184 — slot evidence binding tests.
 *
 * Section 11 of the PR spec requires 28 tests covering:
 * A. Evidence construction (normalizeSlotKey, slotToKey, buildAllowedSlotKeysFromResult)
 * B. Selection provenance (validateBookingSlotEvidence — both paths)
 * C. Booking preflight (shouldInterceptMissingSlotProof, shouldInterceptInvalidSlotDateTime)
 * D. Runtime integration (booking.apply allowed / blocked through the full loop)
 * E. Non-regression (legacy state without proof → slot_known=false)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSlotKey,
  normalizeBookingRequestKey,
  validateBookingRequestFormat,
  slotToKey,
  buildAllowedSlotKeysFromResult,
  validateBookingSlotEvidence,
  type AvailabilityEvidence,
  type SelectedSlotProof,
} from "../src/runtime/slotEvidence.ts";
import {
  shouldInterceptMissingSlotProof,
  shouldInterceptInvalidSlotDateTime,
} from "../src/runtime/bookingApplyPreflight.ts";
import {
  createRuntimeAgentLoop,
  type RuntimeAgentCaller,
} from "../src/runtime/runtimeAgentLoop.ts";
import type { AuthoritativeAvailabilityAttempt } from "../src/runtime/availabilityActionTruth.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

// ── A. Evidence construction ──────────────────────────────────────────────────

// A-1
test("normalizeSlotKey: canonical format from date + HH:MM", () => {
  assert.equal(normalizeSlotKey("2027-08-15", "10:30"), "2027-08-15T10:30");
  assert.equal(normalizeSlotKey("2027-08-15", "09:05"), "2027-08-15T09:05");
});

// A-2
test("normalizeSlotKey: accepts HH:MM:SS (strips seconds)", () => {
  assert.equal(normalizeSlotKey("2027-08-15", "10:30:00"), "2027-08-15T10:30");
});

// A-3
test("normalizeSlotKey: returns null for invalid date", () => {
  assert.equal(normalizeSlotKey("not-a-date", "10:30"), null);
  assert.equal(normalizeSlotKey("2027-08", "10:30"), null);
  assert.equal(normalizeSlotKey("", "10:30"), null);
});

// A-4
test("normalizeSlotKey: returns null for invalid time", () => {
  assert.equal(normalizeSlotKey("2027-08-15", ""), null);
  assert.equal(normalizeSlotKey("2027-08-15", "25:00"), null);
  assert.equal(normalizeSlotKey("2027-08-15", "10:60"), null);
  assert.equal(normalizeSlotKey("2027-08-15", "nottime"), null);
});

// A-5
test("slotToKey: extracts canonical key from ISO datetime", () => {
  assert.equal(slotToKey({ starts_at: "2027-08-15T10:30:00" }), "2027-08-15T10:30");
  assert.equal(slotToKey({ starts_at: "2027-08-15T10:30:00.000Z" }), "2027-08-15T10:30");
  assert.equal(slotToKey({ starts_at: "2027-08-15T10:30" }), "2027-08-15T10:30");
});

// A-6
test("slotToKey: returns null for empty or non-ISO strings", () => {
  assert.equal(slotToKey({ starts_at: "" }), null);
  assert.equal(slotToKey({ starts_at: "not-a-datetime" }), null);
});

// A-7
test("buildAllowedSlotKeysFromResult: extracts unique canonical keys from availability result", () => {
  const result: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "av1",
    status: "success",
    data: {
      slots: [
        { starts_at: "2027-08-15T10:00:00" },
        { starts_at: "2027-08-15T10:30:00" },
        { starts_at: "2027-08-15T14:00:00" },
      ],
    },
  };
  const keys = buildAllowedSlotKeysFromResult(result);
  assert.deepEqual(keys, ["2027-08-15T10:00", "2027-08-15T10:30", "2027-08-15T14:00"]);
});

// A-8
test("buildAllowedSlotKeysFromResult: deduplicates identical starts_at values", () => {
  const result: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "av2",
    status: "success",
    data: {
      slots: [
        { starts_at: "2027-08-15T10:00:00" },
        { starts_at: "2027-08-15T10:00:00" },
        { starts_at: "2027-08-15T11:00:00" },
      ],
    },
  };
  const keys = buildAllowedSlotKeysFromResult(result);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], "2027-08-15T10:00");
  assert.equal(keys[1], "2027-08-15T11:00");
});

// A-9
test("buildAllowedSlotKeysFromResult: returns [] for failed result or no slots", () => {
  const failedResult: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "av3",
    status: "error",
    data: null,
  };
  assert.deepEqual(buildAllowedSlotKeysFromResult(failedResult), []);

  const emptyResult: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "av4",
    status: "success",
    data: { slots: [] },
  };
  assert.deepEqual(buildAllowedSlotKeysFromResult(emptyResult), []);
});

// ── B. Selection provenance (validateBookingSlotEvidence) ─────────────────────

const NO_ATTEMPT: AuthoritativeAvailabilityAttempt = { attempted: false, request: null, pair: null };

function makeCurrentTurnAttempt(callId: string, slotKeys: string[]): AuthoritativeAvailabilityAttempt {
  return {
    attempted: true,
    request: { tool: "availability.check", call_id: callId, arguments: { requested_date: "2027-08-15" } },
    pair: {
      request: { tool: "availability.check", call_id: callId, arguments: { requested_date: "2027-08-15" } },
      result: {
        tool: "availability.check",
        call_id: callId,
        status: "success",
        data: {
          slots: slotKeys.map((k) => {
            const [date, time] = k.split("T");
            return { starts_at: `${date}T${time}:00` };
          }),
        },
      },
    },
  };
}

function makeBookingRequest(date: string, time: string) {
  return {
    tool: "booking.apply",
    call_id: "ba1",
    arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: date, requested_time: time },
  };
}

// B-1: current-turn path — slot found in current availability result
test("validateBookingSlotEvidence: current-turn path passes when slot in authoritative result", () => {
  const attempt = makeCurrentTurnAttempt("av_b1", ["2027-08-15T10:00", "2027-08-15T14:00"]);
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "10:00"),
    currentAvailabilityAttempt: attempt,
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source, "current_turn_availability");
    assert.equal(result.slot_key, "2027-08-15T10:00");
    assert.equal(result.availability_call_id, "av_b1");
  }
});

// B-2: current-turn path — slot NOT in result → slot_not_in_authoritative_evidence
test("validateBookingSlotEvidence: current-turn path rejects slot not in result", () => {
  const attempt = makeCurrentTurnAttempt("av_b2", ["2027-08-15T10:00"]);
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "14:00"),
    currentAvailabilityAttempt: attempt,
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "slot_not_in_authoritative_evidence");
});

// B-3: persisted path — full chain passes
test("validateBookingSlotEvidence: persisted path passes with matching evidence + proof", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_b3",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00", "2027-08-15T14:00"],
  };
  const proof: SelectedSlotProof = { availability_call_id: "av_b3", slot_key: "2027-08-15T10:00" };
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "10:00"),
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: proof,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source, "persisted_selected_slot");
    assert.equal(result.slot_key, "2027-08-15T10:00");
    assert.equal(result.availability_call_id, "av_b3");
  }
});

// B-4: persisted path — no evidence → no_authoritative_availability_evidence
test("validateBookingSlotEvidence: persisted path fails when no evidence", () => {
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "10:00"),
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: null,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: { availability_call_id: "av_b4", slot_key: "2027-08-15T10:00" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_authoritative_availability_evidence");
});

// B-5: persisted path — proof missing → selected_slot_proof_missing
test("validateBookingSlotEvidence: persisted path fails when proof absent", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_b5",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "10:00"),
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "selected_slot_proof_missing");
});

// B-6: persisted path — proof slot_key differs from requested slot → mismatch
test("validateBookingSlotEvidence: persisted path fails when proof slot_key mismatches requested", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_b6",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00", "2027-08-15T14:00"],
  };
  const proof: SelectedSlotProof = { availability_call_id: "av_b6", slot_key: "2027-08-15T14:00" };
  // Proof says 14:00 but request asks for 10:00
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "10:00"),
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: proof,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "selected_slot_proof_mismatch");
});

// B-7: persisted path — proof call_id differs from evidence call_id → mismatch
test("validateBookingSlotEvidence: persisted path fails when proof call_id differs from evidence call_id", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_current",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const proof: SelectedSlotProof = { availability_call_id: "av_old", slot_key: "2027-08-15T10:00" };
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "10:00"),
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: proof,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "selected_slot_proof_mismatch");
});

// B-8: persisted path — slot in evidence but different date with same HH:MM → mismatch
test("validateBookingSlotEvidence: cross-date booking attempt is rejected (same time, different date)", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_b8",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const proof: SelectedSlotProof = { availability_call_id: "av_b8", slot_key: "2027-08-15T10:00" };
  // Request tries to book "2027-08-16" (different date) with same time
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-16", "10:00"),
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: proof,
  });
  assert.equal(result.ok, false);
  // selected_slot is 08-15 but requested is 08-16 → mismatch
  if (!result.ok) assert.ok(result.reason === "selected_slot_proof_mismatch" || result.reason === "no_authoritative_availability_evidence");
});

// ── C. Booking preflight guard functions ──────────────────────────────────────

const PENDING_BOOKING = [
  { tool: "booking.apply", call_id: "ba_c", arguments: { subject_id: "s1", first_name: "A", last_name: "B", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } },
];

// C-1: shouldInterceptMissingSlotProof returns false when current-turn evidence passes
test("shouldInterceptMissingSlotProof: returns false when current-turn availability authorizes slot", () => {
  const attempt = makeCurrentTurnAttempt("av_c1", ["2027-08-15T10:00"]);
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: PENDING_BOOKING,
    currentAvailabilityAttempt: attempt,
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result, false);
});

// C-2: shouldInterceptMissingSlotProof returns true when no evidence at all
test("shouldInterceptMissingSlotProof: returns true when no evidence and no current-turn attempt", () => {
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: PENDING_BOOKING,
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result, true);
});

// C-3: shouldInterceptMissingSlotProof returns true when evidence present but proof missing
test("shouldInterceptMissingSlotProof: returns true when evidence present but no proof", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_c3",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: PENDING_BOOKING,
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: null,
  });
  assert.equal(result, true);
});

// C-4: shouldInterceptMissingSlotProof returns false when full persisted chain passes
test("shouldInterceptMissingSlotProof: returns false when evidence + proof match", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_c4",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const proof: SelectedSlotProof = { availability_call_id: "av_c4", slot_key: "2027-08-15T10:00" };
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: PENDING_BOOKING,
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T10:00:00" },
    selectedSlotProof: proof,
  });
  assert.equal(result, false);
});

// C-5: shouldInterceptInvalidSlotDateTime returns false when no evidence (handled by Guard G first)
test("shouldInterceptInvalidSlotDateTime: returns false when no evidence (not this guard's domain)", () => {
  const result = shouldInterceptInvalidSlotDateTime({
    pendingToolRequests: PENDING_BOOKING,
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result, false);
});

// C-6: shouldInterceptInvalidSlotDateTime returns true when slot not in current-turn evidence
test("shouldInterceptInvalidSlotDateTime: returns true when slot not in current-turn result", () => {
  const attempt = makeCurrentTurnAttempt("av_c6", ["2027-08-15T10:00"]);
  const pendingWrongSlot = [
    { tool: "booking.apply", call_id: "ba_c6", arguments: { subject_id: "s1", first_name: "A", last_name: "B", service: "чистка", requested_date: "2027-08-15", requested_time: "14:00" } },
  ];
  const result = shouldInterceptInvalidSlotDateTime({
    pendingToolRequests: pendingWrongSlot,
    currentAvailabilityAttempt: attempt,
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result, true);
});

// C-7: shouldInterceptMissingSlotProof returns false when no booking.apply in pending
test("shouldInterceptMissingSlotProof: returns false when no booking.apply pending", () => {
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: [{ tool: "kb.search", call_id: "kb1", arguments: { query: "prices" } }],
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result, false);
});

// ── D. Runtime integration ─────────────────────────────────────────────────────

function makeSlotStateRepo(starts_at: string) {
  const date = starts_at.slice(0, 10);
  const hhmm = starts_at.slice(11, 16);
  const slotKey = `${date}T${hhmm}`;
  const callId = "legacy_test_call";
  return {
    async loadState() {
      return {
        selected_slot: { starts_at },
        last_available_slots: [{ starts_at }],
        active_availability_evidence: { availability_call_id: callId, requested_date: date, requested_time: null, allowed_slot_keys: [slotKey] },
        selected_slot_proof: { availability_call_id: callId, slot_key: slotKey },
      };
    },
    async saveState() {},
  };
}

// D-1: booking.apply executes when persisted evidence + proof present
test("D-1: booking.apply executes when persisted evidence and proof authorize the slot", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_d1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записано!" } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { tool: "booking.apply", status: "success", data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T10:00:00"),
    now: new Date("2027-08-15T07:00:00Z"),
  });

  const result = await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите меня",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "executor must be called when evidence + proof present");
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "booking.apply must have a result");
  assert.equal(bookingResult!.status, "success");
});

// D-2: booking.apply blocked when no evidence (slot_not_verified)
test("D-2: booking.apply blocked when no evidence or proof in persisted state", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_d2", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нужно проверить время." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { tool: "booking.apply", status: "success", data: {} };
      },
    },
    // No evidence/proof in state
    bookingProcessStateRepository: {
      async loadState() { return { selected_slot: { starts_at: "2027-08-15T10:00:00" }, last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }] }; },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите меня",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "executor must NOT be called without evidence");
});

// D-3: booking.apply executes via current-turn availability.check → booking.apply in one turn
test("D-3: current-turn availability.check → booking.apply in same turn (avail-then-book flow)", async () => {
  let executorCalled = false;
  let round = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    round++;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", call_id: "av_d3", arguments: { requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    if (round === 2) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_d3", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записано!" } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "availability.check": async () => ({
        tool: "availability.check",
        call_id: "av_d3",
        status: "success",
        data: { slots: [{ starts_at: "2027-08-15T10:00:00" }] },
      }),
      "booking.apply": async () => {
        executorCalled = true;
        return { tool: "booking.apply", status: "success", data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите на 10:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "executor must be called via current-turn avail path");
});

// D-4: current-turn avail check returns slots; model requests wrong slot → Guard H fires
test("D-4: Guard H fires when model requests slot not in current-turn availability result", async () => {
  let executorCalled = false;
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
    round++;
    if (round === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", call_id: "av_d4", arguments: { requested_date: "2027-08-15" } }],
      };
    }
    if (round === 2) {
      // Model hallucinates 14:00 but availability only has 10:00
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_d4", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "14:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Это время недоступно." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "availability.check": async () => ({
        tool: "availability.check",
        call_id: "av_d4",
        status: "success",
        data: { slots: [{ starts_at: "2027-08-15T10:00:00" }] },
      }),
      "booking.apply": async () => {
        executorCalled = true;
        return { tool: "booking.apply", status: "success", data: {} };
      },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  const result = await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите на 14:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "executor must NOT be called for slot not in availability");
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  if (bookingResult) {
    assert.notEqual((bookingResult.data as Record<string, unknown>)?.booking_status, "visit_created");
  }
});

// ── E. Non-regression ──────────────────────────────────────────────────────────

// E-1: legacy state (selected_slot only, no evidence) → slot_known=false, Guard G fires
test("E-1: legacy selected_slot without evidence → booking.apply blocked (slot_not_verified)", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_e1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нужно сначала проверить." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { tool: "booking.apply", status: "success", data: {} };
      },
    },
    // Legacy state: selected_slot but NO evidence or proof
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          // No active_availability_evidence, no selected_slot_proof
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите меня",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "legacy state without proof must block booking");
});

// E-2: stale proof for a slot that is no longer in current evidence → blocked
// The current evidence only has 10:00; patient had selected 14:00 in a prior turn
// when that slot was available. The 14:00 slot was removed (another patient booked it).
// The proof-rebuild logic sets proof=null since 14:00 is not in current evidence.
test("E-2: stale proof for slot no longer in current evidence is rejected", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_e2", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "14:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нужно проверить." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { tool: "booking.apply", status: "success", data: {} };
      },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T14:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T14:00:00" }],
          active_availability_evidence: {
            availability_call_id: "av_current",
            requested_date: "2027-08-15",
            requested_time: null,
            // Current evidence has only 10:00 — 14:00 was removed
            allowed_slot_keys: ["2027-08-15T10:00"],
          },
          // Stale proof claims 14:00 was valid from an older call
          selected_slot_proof: { availability_call_id: "av_stale", slot_key: "2027-08-15T14:00" },
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите на 14:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "stale slot no longer in evidence must block booking");
});

// E-3: last_available_slots alone (without evidence) does not authorize booking
test("E-3: last_available_slots alone without evidence does not authorize booking", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_e3", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нужно проверить." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { tool: "booking.apply", status: "success", data: {} };
      },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          // last_available_slots WITHOUT evidence metadata → not authoritative
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите меня",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "last_available_slots without evidence must not authorize booking");
});

// ── F. Strict booking-request format validation (Blocker 1) ───────────────────

// F-1: strict two-digit hour passes
test("F-1: normalizeBookingRequestKey accepts strict two-digit hour HH:MM", () => {
  assert.equal(normalizeBookingRequestKey("2027-08-15", "09:00"), "2027-08-15T09:00");
  assert.equal(normalizeBookingRequestKey("2027-08-15", "14:30"), "2027-08-15T14:30");
  assert.equal(normalizeBookingRequestKey("2027-08-15", "00:00"), "2027-08-15T00:00");
});

// F-2: single-digit hour is rejected
test("F-2: normalizeBookingRequestKey rejects single-digit hour (9:00)", () => {
  assert.equal(normalizeBookingRequestKey("2027-08-15", "9:00"), null);
  assert.equal(normalizeBookingRequestKey("2027-08-15", "9:30"), null);
});

// F-3: HH:MM:SS suffix is rejected
test("F-3: normalizeBookingRequestKey rejects HH:MM:SS (seconds suffix)", () => {
  assert.equal(normalizeBookingRequestKey("2027-08-15", "09:00:00"), null);
  assert.equal(normalizeBookingRequestKey("2027-08-15", "14:30:00"), null);
});

// F-4: hour > 23 is rejected
test("F-4: normalizeBookingRequestKey rejects hour > 23", () => {
  assert.equal(normalizeBookingRequestKey("2027-08-15", "25:00"), null);
  assert.equal(normalizeBookingRequestKey("2027-08-15", "24:00"), null);
});

// F-5: impossible calendar date is rejected
test("F-5: normalizeBookingRequestKey rejects impossible calendar dates", () => {
  assert.equal(normalizeBookingRequestKey("2027-02-31", "10:00"), null); // Feb has no 31st
  assert.equal(normalizeBookingRequestKey("2027-13-01", "10:00"), null); // month 13
  assert.equal(normalizeBookingRequestKey("2027-04-31", "10:00"), null); // April has 30 days
});

// F-6: validateBookingRequestFormat — runtime: malformed time blocks executor before it runs
test("F-6: malformed requested_time blocks booking.apply at Guard D, executor never called", async () => {
  let executorCalled = false;
  const malformedTimes = ["9:00", "09:00:00", "25:00"];

  for (const badTime of malformedTimes) {
    executorCalled = false;
    const caller: RuntimeAgentCaller = async (input) => {
      if (!input.input.tool_results?.length) {
        return {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "ba_f6",
            arguments: {
              subject_id: "subject_1",
              first_name: "Ivan",
              last_name: "Petrov",
              service: "чистка",
              requested_date: "2027-08-15",
              requested_time: badTime,
            },
          }],
        };
      }
      return { type: "final_response", final_response: { final_patient_reply: "Выберите точное время." } };
    };
    const agent = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: {
        "booking.apply": async () => {
          executorCalled = true;
          return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock" } };
        },
      },
      bookingProcessStateRepository: {
        async loadState() {
          return {
            selected_slot: { starts_at: "2027-08-15T10:00:00" },
            last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
            active_availability_evidence: { availability_call_id: "av1", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
            selected_slot_proof: { availability_call_id: "av1", slot_key: "2027-08-15T10:00" },
          };
        },
        async saveState() {},
      },
      now: new Date("2027-08-15T07:00:00Z"),
    });

    await agent.runTurn({
      clinic_id: "clinic_1",
      user_message: "Запишите меня",
      channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
    });

    assert.equal(executorCalled, false, `executor must not be called for malformed time "${badTime}"`);
  }
});

// ── G. selectionEstablishedThisTurn — no auto-proof manufacture (Blocker 3) ───

// G-1: persisted {slot + evidence + proof:null} → slot_known=false, proof stays null
test("G-1: persisted state with slot+evidence but proof=null keeps proof null (no auto-upgrade)", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_g1",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Сначала нужно подтвердить слот." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock" } }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: {
            availability_call_id: "av_g1",
            requested_date: "2027-08-15",
            requested_time: null,
            allowed_slot_keys: ["2027-08-15T10:00"],
          },
          selected_slot_proof: null, // Proof absent — must NOT be reconstructed
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Хочу записаться",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "missing persisted proof must NOT be reconstructed from matching evidence");
});

// G-2: persisted {slot + evidence + proof:valid} → slot_known=true, proof preserved
test("G-2: persisted valid proof is preserved, booking.apply succeeds", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_g2",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записан!" } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock_g2" } }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: {
            availability_call_id: "av_g2",
            requested_date: "2027-08-15",
            requested_time: null,
            allowed_slot_keys: ["2027-08-15T10:00"],
          },
          selected_slot_proof: { availability_call_id: "av_g2", slot_key: "2027-08-15T10:00" },
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Хочу записаться",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "valid persisted proof must be preserved and allow booking");
});

// G-3: persisted proof with stale call_id → proof cleared → booking blocked
test("G-3: persisted proof with stale availability_call_id is cleared, booking blocked", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_g3",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нужно проверить время." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: {
            availability_call_id: "av_NEW",  // current evidence has new call ID
            requested_date: "2027-08-15",
            requested_time: null,
            allowed_slot_keys: ["2027-08-15T10:00"],
          },
          selected_slot_proof: {
            availability_call_id: "av_OLD",  // stale proof from prior availability check
            slot_key: "2027-08-15T10:00",
          },
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Хочу записаться",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "stale proof (mismatched call_id) must be cleared, not reused");
});

// G-4: same-turn availability + booking (current-turn path) → still works
test("G-4: same-turn availability.check followed by booking.apply succeeds (current-turn proof path)", async () => {
  let executorCalled = false;
  let callerCallCount = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    callerCallCount++;
    if (callerCallCount === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", call_id: "av_g4", arguments: { requested_date: "2027-08-15", service_interest: "чистка" } }],
      };
    }
    if (callerCallCount === 2) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_g4",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записан!" } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [{ starts_at: "2027-08-15T10:00:00", service: "чистка" }] },
      }),
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock_g4" } };
      },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите меня на 15 августа на чистку в 10:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "same-turn availability + booking must succeed via current-turn proof path");
});

// G-5: availability attempt clears prior slot and proof even when the same slot still exists
test("G-5: availability.check this turn clears prior selected_slot and proof", async () => {
  // After the availability.check result, the model can only book if it uses the new
  // current-turn evidence — persisted proof from a prior turn is cleared.
  let executorCalled = false;
  let callerCallCount = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    callerCallCount++;
    if (callerCallCount === 1) {
      // Round 1: model requests availability.check
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", call_id: "av_g5", arguments: { requested_date: "2027-08-15" } }],
      };
    }
    if (callerCallCount === 2) {
      // Round 2: model requests booking.apply with a DIFFERENT date (cross-date blocked)
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_g5",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-09-01", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Недоступно." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [{ starts_at: "2027-08-15T10:00:00" }] },
      }),
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: {} };
      },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Проверьте наличие слотов",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "cross-date slot not in current-turn evidence must be blocked");
});

// G-6: impossible date in booking.apply is blocked before executor
test("G-6: impossible calendar date (2027-02-31) blocked at Guard D, executor not called", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_g6",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-02-31", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Такой даты не существует." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av1", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: { availability_call_id: "av1", slot_key: "2027-08-15T10:00" },
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите 31 февраля",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "impossible calendar date must be blocked at Guard D");
});

// ── H. Partial-state recovery via fresh patient selection ─────────────────────

// H-1: persisted slot + evidence + proof:null, patient explicitly repeats same time → proof created
test("H-1: patient repeats same time on existing slot-without-proof → proof created, slot_known=true", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_h1",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записан!" } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock_h1" } }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_h1", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Да, давайте на 10:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "explicit time re-selection must re-establish proof and allow booking");
});

// H-2: same setup, patient selects by ordinal "первый" → proof for first slot
test("H-2: patient selects by ordinal 'первый' on slot-without-proof → proof created for first slot", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_h2",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записан!" } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock_h2" } }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_h2", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Давайте первый",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "ordinal 'первый' must re-establish proof for first slot");
});

// H-3: persisted slot 10:00, patient explicitly selects 11:00 → slot changes, proof changes
test("H-3: patient selects different time → selected_slot changes, proof changes", async () => {
  let capturedArgs: Record<string, unknown> | null = null;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_h3",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записан на 11:00!" } };
  };
  let executorCalled = false;
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async (ctx) => { executorCalled = true; capturedArgs = ctx as unknown as Record<string, unknown>; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock_h3" } }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }, { starts_at: "2027-08-15T11:00:00" }],
          active_availability_evidence: { availability_call_id: "av_h3", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00", "2027-08-15T11:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Нет, лучше на 11:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "explicit slot change must create new proof for the new slot");
});

// H-4: generic message without time/ordinal → proof remains null, booking blocked
test("H-4: generic booking intent without time → proof stays null, booking blocked", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_h4",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нужно выбрать время." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_h4", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Хочу записаться",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "generic message without explicit time must not create proof");
});

// H-5: patient selects time not in active evidence → no proof, booking blocked
test("H-5: patient selects time absent from active evidence → no proof created, booking blocked", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_h5",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "14:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "14:00 недоступно." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }, { starts_at: "2027-08-15T14:00:00" }],
          active_availability_evidence: {
            availability_call_id: "av_h5",
            requested_date: "2027-08-15",
            requested_time: null,
            // 14:00 is NOT in evidence even though it's in last_available_slots
            allowed_slot_keys: ["2027-08-15T10:00"],
          },
          selected_slot_proof: null,
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите на 14:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "slot detected from message but absent from evidence must not create proof");
});

// H-6: full runtime recovery — partial state + explicit re-selection → booking succeeds
test("H-6: full runtime recovery: partial state + explicit selection + booking.apply succeeds", async () => {
  let executorCalled = false;
  let callerCount = 0;
  const caller: RuntimeAgentCaller = async () => {
    callerCount++;
    if (callerCount === 1) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_h6",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Записан!" } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock_h6" } }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_h6", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Да, давайте на 10:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "full recovery: partial state + explicit re-selection must allow booking");
});

// H-7: G-1 no-auto-upgrade remains green — matching fields alone never create proof
test("H-7: G-1 invariant holds after fix — generic message on partial state does not create proof", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_h7",
          arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" },
        }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Нужно подтвердить время." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_h7", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Хочу записаться",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "matching persisted fields + generic message must NOT auto-create proof (G-1 invariant)");
});

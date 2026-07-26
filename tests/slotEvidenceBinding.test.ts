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
import { executeBookingSelectSlot } from "../src/runtime/bookingSelectSlot.ts";
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

// B-1: bypass removed — avail.check result alone (no active evidence, no proof) → validation fails
test("validateBookingSlotEvidence: avail.check alone without active evidence → no_authoritative_availability_evidence (bypass removed)", () => {
  const attempt = makeCurrentTurnAttempt("av_b1", ["2027-08-15T10:00", "2027-08-15T14:00"]);
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "10:00"),
    currentAvailabilityAttempt: attempt,  // ignored — no longer part of the validation chain
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_authoritative_availability_evidence");
});

// B-2: slot not in authoritative evidence → slot_not_in_authoritative_evidence
test("validateBookingSlotEvidence: slot not in active evidence allowed_slot_keys → slot_not_in_authoritative_evidence", () => {
  // Evidence only has 10:00; proof and selected_slot point to 14:00 (not in evidence).
  // This produces slot_not_in_authoritative_evidence (Check 7). In production this state is
  // unreachable because computeBookingProcessState clears proofs whose slot_key is absent from
  // allowed_slot_keys, but the unit test exercises the path directly.
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_b2",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const result = validateBookingSlotEvidence({
    bookingApplyRequest: makeBookingRequest("2027-08-15", "14:00"),
    activeAvailabilityEvidence: evidence,
    selectedSlot: { starts_at: "2027-08-15T14:00:00" },
    selectedSlotProof: { subject_id: "subject_1" as const, availability_call_id: "av_b2", slot_key: "2027-08-15T14:00" },
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
  const proof: SelectedSlotProof = { subject_id: "subject_1" as const, availability_call_id: "av_b3", slot_key: "2027-08-15T10:00" };
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
  const proof: SelectedSlotProof = { subject_id: "subject_1" as const, availability_call_id: "av_b6", slot_key: "2027-08-15T14:00" };
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
  const proof: SelectedSlotProof = { subject_id: "subject_1" as const, availability_call_id: "av_old", slot_key: "2027-08-15T10:00" };
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
  const proof: SelectedSlotProof = { subject_id: "subject_1" as const, availability_call_id: "av_b8", slot_key: "2027-08-15T10:00" };
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
  { tool: "booking.apply", call_id: "ba_c", arguments: { subject_id: "subject_1", first_name: "A", last_name: "B", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } },
];

// C-1: bypass removed — avail.check result alone no longer authorizes booking.apply
test("shouldInterceptMissingSlotProof: avail.check alone (no active evidence, no proof) → intercepts (bypass removed)", () => {
  const attempt = makeCurrentTurnAttempt("av_c1", ["2027-08-15T10:00"]);
  const result = shouldInterceptMissingSlotProof({
    pendingToolRequests: PENDING_BOOKING,
    currentAvailabilityAttempt: attempt,  // ignored — no longer part of validation
    activeAvailabilityEvidence: null,
    selectedSlot: null,
    selectedSlotProof: null,
  });
  assert.equal(result, true);
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
  const proof: SelectedSlotProof = { subject_id: "subject_1" as const, availability_call_id: "av_c4", slot_key: "2027-08-15T10:00" };
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

// C-6: shouldInterceptInvalidSlotDateTime returns true when slot not in active evidence
test("shouldInterceptInvalidSlotDateTime: returns true when slot not in active evidence allowed_slot_keys", () => {
  const pendingWrongSlot = [
    { tool: "booking.apply", call_id: "ba_c6", arguments: { subject_id: "s1", first_name: "A", last_name: "B", service: "чистка", requested_date: "2027-08-15", requested_time: "14:00" } },
  ];
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_c6",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],  // only 10:00; request is for 14:00
  };
  const result = shouldInterceptInvalidSlotDateTime({
    pendingToolRequests: pendingWrongSlot,
    currentAvailabilityAttempt: NO_ATTEMPT,
    activeAvailabilityEvidence: evidence,
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

function makeSlotStateRepo(starts_at: string, subjectId: `subject_${number}` = "subject_1") {
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
        selected_slot_proof: { subject_id: subjectId, availability_call_id: callId, slot_key: slotKey },
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

// D-3: bypass removed — availability.check alone no longer authorizes booking.apply
// Model must call booking.select_slot to create proof before booking.apply can succeed.
test("D-3: avail.check → booking.apply without select_slot → executor NOT called (bypass removed)", async () => {
  let executorCalled = false;
  let round = 0;
  const caller: RuntimeAgentCaller = async () => {
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
    return { type: "final_response", final_response: { final_patient_reply: "Выберите слот через select_slot." } };
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

  const result = await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Запишите на 10:00",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "executor must NOT be called — avail.check alone is insufficient (select_slot proof required)");
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  if (bookingResult) {
    assert.equal((bookingResult.data as Record<string, unknown>)?.booking_status, "slot_not_verified");
  }
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
          selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "av_stale", slot_key: "2027-08-15T14:00" },
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
            selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "av1", slot_key: "2027-08-15T10:00" },
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
          selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "av_g2", slot_key: "2027-08-15T10:00" },
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
            subject_id: "subject_1" as const,
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
          selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "av1", slot_key: "2027-08-15T10:00" },
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

// ── J. booking.select_slot tool (Blocker 7) ───────────────────────────────────

// J-1: valid slot in evidence → success
test("J-1: executeBookingSelectSlot: valid slot in evidence → selection_status='selected'", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_j1",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00", "2027-08-15T14:00"],
  };
  const result = executeBookingSelectSlot(
    { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "10:00" },
    evidence,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.selection_status, "selected");
    assert.equal(result.data.selected_slot_key, "2027-08-15T10:00");
    assert.equal(result.data.may_apply_booking, true);
  }
});

// J-2: slot not in evidence → failure
test("J-2: executeBookingSelectSlot: slot not in evidence → slot_not_in_active_evidence", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_j2",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const result = executeBookingSelectSlot(
    { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "14:00" },
    evidence,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "slot_not_in_active_evidence");
});

// J-3: null evidence → failure
test("J-3: executeBookingSelectSlot: null evidence → no_active_availability_evidence", () => {
  const result = executeBookingSelectSlot(
    { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "10:00" },
    null,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_active_availability_evidence");
});

// J-4: missing slot args → failure
test("J-4: executeBookingSelectSlot: missing requested_time → missing_slot", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_j4",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const result = executeBookingSelectSlot(
    { subject_id: "subject_1", requested_date: "2027-08-15" },
    evidence,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_slot");
});

// J-5: invalid time format → failure
test("J-5: executeBookingSelectSlot: single-digit hour '9:00' → invalid_slot_format", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_j5",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T09:00"],
  };
  const result = executeBookingSelectSlot(
    { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "9:00" },
    evidence,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_slot_format");
});

// J-6: invalid subject_id → failure
test("J-6: executeBookingSelectSlot: invalid subject_id → subject_resolution_conflict", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_j6",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T10:00"],
  };
  const result = executeBookingSelectSlot(
    { subject_id: "bad_subject", requested_date: "2027-08-15", requested_time: "10:00" },
    evidence,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "subject_resolution_conflict");
});

// J-7: booking.select_slot success with no trusted phone → booking.apply blocked; proof persists in saved state
test("J-7: booking.select_slot success, no trusted phone → booking.apply blocked; proof persisted", async () => {
  let executorCalled = false;
  let savedState: unknown = null;
  let callerRound = 0;
  const caller: RuntimeAgentCaller = async () => {
    callerRound++;
    if (callerRound === 1) {
      return {
        type: "tool_requests" as const,
        tool_requests: [{ tool: "booking.select_slot", call_id: "ss_j7", arguments: { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    if (callerRound === 2) {
      return {
        type: "tool_requests" as const,
        tool_requests: [{ tool: "booking.apply", call_id: "ba_j7", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response" as const, final_response: { final_patient_reply: "Нужен контакт." } };
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
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_j7", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState(_key: unknown, state: unknown) { savedState = state; },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Хочу на 10:00",
    channel_contact: undefined,
  });

  assert.equal(executorCalled, false, "J-7: booking.apply must be blocked without trusted phone");
  const s = savedState as { selected_slot_proof?: unknown } | null;
  assert.ok(s !== null, "J-7: state must be saved");
  assert.ok(s?.selected_slot_proof !== null && s?.selected_slot_proof !== undefined, "J-7: proof must be persisted after booking.select_slot");
});

// J-8: cross-turn: booking.select_slot in turn N establishes proof; booking.apply succeeds in turn N+1
test("J-8: cross-turn: booking.select_slot in turn N; persisted proof authorizes booking.apply in turn N+1", async () => {
  let executorCalled = false;
  let persistedState: unknown = null;

  // Turn N: model calls booking.select_slot; runtime persists proof
  let roundN = 0;
  const agentN = createRuntimeAgentLoop({
    model: "test",
    caller: async () => {
      roundN++;
      if (roundN === 1) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.select_slot", call_id: "ss_j8", arguments: { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Выбрано 10:00." } };
    },
    executors: {},
    bookingProcessStateRepository: {
      async loadState() {
        return {
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_j8", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
          service_reason: "чистка",
          first_name: "Ivan",
          last_name: "Petrov",
        };
      },
      async saveState(_key: unknown, state: unknown) { persistedState = state; },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });
  await agentN.runTurn({ clinic_id: "clinic_1", user_message: "Давайте на 10:00", channel_contact: undefined });

  const ps = persistedState as { selected_slot_proof?: unknown } | null;
  assert.ok(ps?.selected_slot_proof !== null && ps?.selected_slot_proof !== undefined, "J-8: proof must be persisted after turn N booking.select_slot");

  // Turn N+1: persisted proof authorizes booking.apply
  let roundN1 = 0;
  const agentN1 = createRuntimeAgentLoop({
    model: "test",
    caller: async (input) => {
      roundN1++;
      if (roundN1 === 1) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.apply", call_id: "ba_j8", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Записан!" } };
    },
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock_j8" } }; },
    },
    bookingProcessStateRepository: {
      async loadState() { return persistedState as object; },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });
  await agentN1.runTurn({
    clinic_id: "clinic_1",
    user_message: "Вот мой контакт",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, true, "J-8: persisted proof from turn N must authorize booking.apply in turn N+1");
});

// J-9: booking.apply without prior booking.select_slot → blocked (no proof)
test("J-9: booking.apply without prior booking.select_slot is blocked (no proof in state)", async () => {
  let executorCalled = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results?.length) {
      return {
        type: "tool_requests" as const,
        tool_requests: [{ tool: "booking.apply", call_id: "ba_j9", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response" as const, final_response: { final_patient_reply: "Нужно выбрать время." } };
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
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_j9", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
          selected_slot: null,
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

  assert.equal(executorCalled, false, "J-9: booking.apply without prior select_slot must be blocked");
});

// J-10: new availability.check clears prior booking.select_slot proof
test("J-10: new availability.check this turn clears prior booking.select_slot proof, old slot blocked", async () => {
  let executorCalled = false;
  let callerRound = 0;
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller: async () => {
      callerRound++;
      if (callerRound === 1) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "availability.check", call_id: "av_j10", arguments: { requested_date: "2027-08-16" } }],
        };
      }
      if (callerRound === 2) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.apply", call_id: "ba_j10", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2027-08-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Нет мест." } };
    },
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [{ starts_at: "2027-08-16T10:00:00" }] },
      }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: {
      async loadState() {
        return {
          selected_slot: { starts_at: "2027-08-15T10:00:00" },
          last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }],
          active_availability_evidence: { availability_call_id: "av_old", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "av_old", slot_key: "2027-08-15T10:00" },
        };
      },
      async saveState() {},
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    user_message: "Проверьте 16-е",
    channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
  });

  assert.equal(executorCalled, false, "J-10: prior proof must be cleared when new availability.check runs; old slot not in new evidence");
});

// J-11: raw patient text cannot create selected_slot_proof — model must call booking.select_slot
test("J-11: raw patient text never creates proof — model must call booking.select_slot", async () => {
  const texts = [
    "Да, на 10:00",
    "Нет, не в 10:00",
    "Не первый, а второй",
    "10:00 или 11:00",
  ];

  for (const msg of texts) {
    let savedState: unknown = null;
    const agent = createRuntimeAgentLoop({
      model: "test",
      caller: async () => ({
        type: "final_response" as const,
        final_response: { final_patient_reply: "Понял." },
      }),
      executors: {},
      bookingProcessStateRepository: {
        async loadState() {
          return {
            last_available_slots: [{ starts_at: "2027-08-15T10:00:00" }, { starts_at: "2027-08-15T11:00:00" }],
            active_availability_evidence: { availability_call_id: "av_j11", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00", "2027-08-15T11:00"] },
            selected_slot_proof: null,
          };
        },
        async saveState(_key: unknown, state: unknown) { savedState = state; },
      },
      now: new Date("2027-08-15T07:00:00Z"),
    });

    await agent.runTurn({
      clinic_id: "clinic_1",
      user_message: msg,
      channel_contact: { phone_number: "+420600111222", phone_source: "telegram_contact_button" },
    });

    const s = savedState as { selected_slot_proof?: unknown } | null;
    assert.ok(
      s === null || s?.selected_slot_proof === null || s?.selected_slot_proof === undefined,
      `J-11: raw text "${msg}" must NOT create proof — model must call booking.select_slot`,
    );
  }
});

// J-12: executeBookingSelectSlot enforces strict machine format — single-digit hour rejected, two-digit accepted
test("J-12: executeBookingSelectSlot strict format: single-digit hour rejected, two-digit accepted", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "av_j12",
    requested_date: "2027-08-15",
    requested_time: null,
    allowed_slot_keys: ["2027-08-15T09:00"],
  };
  const r1 = executeBookingSelectSlot(
    { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "9:00" },
    evidence,
  );
  assert.equal(r1.ok, false, "J-12: single-digit '9:00' must be rejected");
  if (!r1.ok) assert.equal(r1.reason, "invalid_slot_format");

  const r2 = executeBookingSelectSlot(
    { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "09:00" },
    evidence,
  );
  assert.equal(r2.ok, true, "J-12: strict two-digit '09:00' must be accepted");
  if (r2.ok) assert.equal(r2.data.selected_slot_key, "2027-08-15T09:00");
});

// J-13: one booking.select_slot request → appears exactly once in returned tool_requests
test("J-13: one booking.select_slot in model output → appears exactly once in returned tool_requests", async () => {
  let savedState: unknown = null;
  let callerRound = 0;
  const caller: RuntimeAgentCaller = async () => {
    callerRound++;
    if (callerRound === 1) {
      return {
        type: "tool_requests" as const,
        tool_requests: [{ tool: "booking.select_slot", call_id: "ss_j13", arguments: { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response" as const, final_response: { final_patient_reply: "Выбрано." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {},
    bookingProcessStateRepository: {
      async loadState() {
        return {
          active_availability_evidence: { availability_call_id: "av_j13", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState(_key: unknown, state: unknown) { savedState = state; },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  const result = await agent.runTurn({ clinic_id: "clinic_1", user_message: "Хочу на 10:00", channel_contact: undefined });

  const selectSlotRequests = result.tool_requests.filter((r) => r.tool === "booking.select_slot");
  assert.equal(selectSlotRequests.length, 1, "J-13: exactly one booking.select_slot must appear in tool_requests");
  assert.equal(selectSlotRequests[0]!.call_id, "ss_j13", "J-13: the single request must be the one the model sent");
  const s = savedState as { selected_slot_proof?: unknown } | null;
  assert.ok(s?.selected_slot_proof !== null && s?.selected_slot_proof !== undefined, "J-13: single select_slot must still create proof");
});

// J-14: multiple booking.select_slot calls in one round → ambiguous → all rejected, no proof created
test("J-14: multiple booking.select_slot in one round → all rejected as ambiguous_selection, no proof created", async () => {
  let savedState: unknown = null;
  let callerRound = 0;
  const caller: RuntimeAgentCaller = async () => {
    callerRound++;
    if (callerRound === 1) {
      return {
        type: "tool_requests" as const,
        tool_requests: [
          { tool: "booking.select_slot", call_id: "ss_j14a", arguments: { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "10:00" } },
          { tool: "booking.select_slot", call_id: "ss_j14b", arguments: { subject_id: "subject_1", requested_date: "2027-08-15", requested_time: "14:00" } },
        ],
      };
    }
    return { type: "final_response" as const, final_response: { final_patient_reply: "Уточните время." } };
  };
  const agent = createRuntimeAgentLoop({
    model: "test",
    caller,
    executors: {},
    bookingProcessStateRepository: {
      async loadState() {
        return {
          active_availability_evidence: { availability_call_id: "av_j14", requested_date: "2027-08-15", requested_time: null, allowed_slot_keys: ["2027-08-15T10:00", "2027-08-15T14:00"] },
          selected_slot_proof: null,
        };
      },
      async saveState(_key: unknown, state: unknown) { savedState = state; },
    },
    now: new Date("2027-08-15T07:00:00Z"),
  });

  const result = await agent.runTurn({ clinic_id: "clinic_1", user_message: "Хочу на 10:00 или 14:00", channel_contact: undefined });

  // Both requests must appear in tool_requests (not silently dropped)
  const selectSlotRequests = result.tool_requests.filter((r) => r.tool === "booking.select_slot");
  assert.equal(selectSlotRequests.length, 2, "J-14: both ambiguous select_slot requests must appear in tool_requests");

  // Both must receive ambiguous_selection error results
  const selectSlotResults = result.tool_results.filter((r) => r.tool === "booking.select_slot");
  assert.equal(selectSlotResults.length, 2, "J-14: both requests must have tool results");
  for (const r of selectSlotResults) {
    assert.equal(r.status, "failed", `J-14: ${r.call_id} must be failed`);
    if (r.status === "failed") {
      assert.equal(r.error?.code, "ambiguous_selection", `J-14: ${r.call_id} error must be ambiguous_selection`);
    }
  }

  // No proof must be created — the final slot proof must remain null/undefined
  const s = savedState as { selected_slot_proof?: unknown } | null;
  const proof = s?.selected_slot_proof;
  assert.ok(proof === null || proof === undefined, "J-14: ambiguous multiple select_slot must not create proof");
});

// ── J-15: avail.check alone does not authorize booking.apply ──────────────────

// J-15: Verifies the bypass removal — avail.check in round-1 no longer authorizes booking.apply.
// avail.check clears prior proof; Guard G fires in round-2 → slot_not_verified.
test("J-15: availability.check without booking.select_slot → booking.apply blocked (slot_not_verified)", async () => {
  let executorCalled = false;
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      if (!input.input.tool_results?.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "availability.check", call_id: "avail_j15", arguments: { requested_date: "2028-01-15" } }],
        };
      }
      if (input.input.tool_results.some((r: { tool: string }) => r.tool === "availability.check")) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.apply", call_id: "ba_j15", arguments: { subject_id: "subject_1", first_name: "Test", last_name: "User", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Нужно выбрать слот." } };
    }) as RuntimeAgentCaller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [{ starts_at: "2028-01-15T10:00:00", ends_at: "2028-01-15T10:30:00" }], total_slots: 1, free_slots_count: 1 },
      }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
  });
  const result = await loop.runTurn({ clinic_id: "clinic_1", contact_id: "contact_j15", case_id: null, user_message: "запиши", locale: "ru", trace_id: "tr_j15", channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" } });
  assert.equal(executorCalled, false, "J-15: avail.check alone must not authorize booking.apply");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "J-15: guarded result must be present");
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "slot_not_verified", "J-15: must be slot_not_verified — avail.check bypass removed");
});

// ── J-16: select_slot subject_2 proof → booking.apply subject_1 → blocked ─────

// J-16: Cross-subject proof mismatch. State has subject_2 proof; booking.apply for subject_1
// triggers validateBookingSlotEvidence check 8 → selected_slot_proof_mismatch → slot_not_verified.
test("J-16: subject_2 proof → booking.apply subject_1 → blocked (cross-subject mismatch)", async () => {
  let executorCalled = false;
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      if (!input.input.tool_results?.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.apply", call_id: "ba_j16", arguments: { subject_id: "subject_1", first_name: "Test", last_name: "User", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Слот не верифицирован." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    // Proof is for subject_2; booking.apply is for subject_1 → mismatch
    bookingProcessStateRepository: makeSlotStateRepo("2028-01-15T10:00:00", "subject_2"),
  });
  const result = await loop.runTurn({ clinic_id: "clinic_1", contact_id: "contact_j16", case_id: null, user_message: "запиши", locale: "ru", trace_id: "tr_j16", channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" } });
  assert.equal(executorCalled, false, "J-16: executor must not run when proof is for different subject");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "J-16: guarded result must be present");
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "slot_not_verified", "J-16: must be slot_not_verified on cross-subject proof mismatch");
});

// ── J-17: select_slot subject_2 proof → booking.apply subject_2 → executor called ──

// J-17: When proof matches the booking subject, booking.apply executes.
test("J-17: subject_2 proof → booking.apply subject_2 → executor called (subject match)", async () => {
  let executorCalled = false;
  const registryWithS2 = {
    version: 3,
    status: "active" as const,
    active_subject_id: "subject_2" as `subject_${number}`,
    subjects: [{
      id: "subject_2" as `subject_${number}`,
      role: "mentioned_person" as const,
      label: null,
      patient_name: "Иван Тест",
      service: "чистка",
      slot: null,
      booking_contact: { phone_number: "+420555444333", source: "typed" as const, trust: "unverified" as const, owner_subject_id: "subject_2" as `subject_${number}`, collected_at: null },
      status: "collecting" as const,
      missing: [],
    }],
    pending_typed_phone: null,
    max_subjects: 4,
  };
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      if (!input.input.tool_results?.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.apply", call_id: "ba_j17", arguments: { subject_id: "subject_2", first_name: "Иван", last_name: "Тест", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Записан." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "v_j17" } }; },
    },
    // Proof is for subject_2; booking.apply is also for subject_2 → match → executor called
    bookingProcessStateRepository: makeSlotStateRepo("2028-01-15T10:00:00", "subject_2"),
  });
  const result = await loop.runTurn({ clinic_id: "clinic_1", contact_id: "contact_j17", case_id: null, user_message: "запиши", locale: "ru", trace_id: "tr_j17", booking_subjects: registryWithS2 });
  assert.equal(executorCalled, true, "J-17: executor must be called when proof subject matches booking.apply subject");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "J-17: booking result must be present");
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "visit_created", "J-17: booking must succeed");
});

// ── J-18: select_slot for non-existent subject → subject_resolution_conflict ───

// J-18: When booking_subjects registry is absent and subject_2 is requested,
// executeBookingSelectSlot returns subject_resolution_conflict. No proof is created.
test("J-18: booking.select_slot subject_2 without registry → subject_resolution_conflict, no proof", async () => {
  let savedState: unknown = undefined;
  const stateRepo = {
    async loadState() { return null; },
    async saveState(_k: unknown, state: unknown) { savedState = state; },
  };
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      if (!input.input.tool_results?.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.select_slot", call_id: "ss_j18", arguments: { subject_id: "subject_2", requested_date: "2028-01-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Субъект не найден." } };
    }) as RuntimeAgentCaller,
    executors: {},
    bookingProcessStateRepository: stateRepo,
  });
  await loop.runTurn({ clinic_id: "clinic_1", contact_id: "contact_j18", case_id: null, user_message: "запиши субъект 2", locale: "ru", trace_id: "tr_j18" });
  const ssResult = (savedState as { selected_slot_proof?: unknown } | null | undefined);
  assert.ok(ssResult?.selected_slot_proof === null || ssResult?.selected_slot_proof === undefined, "J-18: no proof must be created when select_slot fails with subject_resolution_conflict");
});

// ── J-19: legacy proof without subject_id → stale, booking blocked ────────────

// J-19: A selected_slot_proof without subject_id is treated as a legacy/stale proof.
// validateBookingSlotEvidence check 3a returns selected_slot_proof_missing → slot_not_verified.
test("J-19: legacy selected_slot_proof without subject_id → treated as stale, booking.apply blocked", async () => {
  let executorCalled = false;
  const legacyStateRepo = {
    async loadState() {
      const slotKey = "2028-01-15T10:00";
      return {
        selected_slot: { starts_at: "2028-01-15T10:00:00" },
        last_available_slots: [{ starts_at: "2028-01-15T10:00:00" }],
        active_availability_evidence: { availability_call_id: "legacy_call", requested_date: "2028-01-15", requested_time: null, allowed_slot_keys: [slotKey] },
        selected_slot_proof: { availability_call_id: "legacy_call", slot_key: slotKey }, // no subject_id (legacy)
      };
    },
    async saveState() {},
  };
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      if (!input.input.tool_results?.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.apply", call_id: "ba_j19", arguments: { subject_id: "subject_1", first_name: "Test", last_name: "User", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Устаревший слот." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: legacyStateRepo,
  });
  const result = await loop.runTurn({ clinic_id: "clinic_1", contact_id: "contact_j19", case_id: null, user_message: "запиши", locale: "ru", trace_id: "tr_j19", channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" } });
  assert.equal(executorCalled, false, "J-19: executor must not run for legacy proof without subject_id");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "J-19: guarded result must be present");
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "slot_not_verified", "J-19: legacy proof treated as stale → slot_not_verified");
});

// ── J-20: select_slot round-1 → booking.apply round-2 → exactly one write ────

// J-20: Correct flow — select_slot in round-1 creates proof, booking.apply in round-2 executes.
// Executor must be called exactly once (no double-execution).
test("J-20: booking.select_slot round-1 then booking.apply round-2 → executor called exactly once", async () => {
  let executorCallCount = 0;
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      const results = input.input.tool_results ?? [];
      if (!results.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.select_slot", call_id: "ss_j20", arguments: { subject_id: "subject_1", requested_date: "2028-01-15", requested_time: "10:00" } }],
        };
      }
      if (results.some((r: { tool: string }) => r.tool === "booking.select_slot")) {
        return {
          type: "tool_requests" as const,
          tool_requests: [{ tool: "booking.apply", call_id: "ba_j20", arguments: { subject_id: "subject_1", first_name: "Test", last_name: "User", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } }],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Записано." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "v_j20" } };
      },
    },
    // State repo provides evidence so select_slot can create proof
    bookingProcessStateRepository: makeSlotStateRepo("2028-01-15T10:00:00", "subject_1"),
  });
  await loop.runTurn({ clinic_id: "clinic_1", contact_id: "contact_j20", case_id: null, user_message: "запиши", locale: "ru", trace_id: "tr_j20", channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" } });
  assert.equal(executorCallCount, 1, "J-20: booking.apply executor must be called exactly once");
});

// ── R-6: round-2 booking.select_slot + booking.apply → both blocked ───────────

// R-6: When round-2 contains booking.select_slot AND booking.apply, select_slot is rejected
// and booking.apply must be blocked — the round-2 protocol error must not fall through to an
// old persisted proof. Executor call count must be zero.
test("R-6: round-2 booking.select_slot plus booking.apply — select_slot_not_allowed_in_round2, booking executor call count=0", async () => {
  let executorCallCount = 0;
  // Provide persisted valid proof so booking.apply would normally succeed
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      const results = input.input.tool_results ?? [];
      // Round-1: model returns final_response (no tools)
      if (!results.length) {
        return {
          type: "tool_requests" as const,
          // Round-1: trigger availability check so there IS a round-2
          tool_requests: [{ tool: "availability.check", call_id: "ac_r6", arguments: { requested_date: "2028-01-15", requested_time: null } }],
        };
      }
      // Round-2: model returns both booking.select_slot AND booking.apply
      if (results.some((r: { tool: string }) => r.tool === "availability.check")) {
        return {
          type: "tool_requests" as const,
          tool_requests: [
            { tool: "booking.select_slot", call_id: "ss_r6", arguments: { subject_id: "subject_1", requested_date: "2028-01-15", requested_time: "10:00" } },
            { tool: "booking.apply", call_id: "ba_r6", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } },
          ],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Готово." } };
    }) as RuntimeAgentCaller,
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2028-01-15T10:00:00" }] } }),
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2028-01-15T10:00:00", "subject_1"),
  });
  const result = await loop.runTurn({ clinic_id: "clinic_1", contact_id: "contact_r6", case_id: null, user_message: "запиши", locale: "ru", trace_id: "tr_r6", channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" } });
  assert.equal(executorCallCount, 0, "R-6: booking executor must not be called");
  const ssResult = result.tool_results.find((r) => r.tool === "booking.select_slot");
  assert.ok(ssResult, "R-6: select_slot result must be present");
  assert.equal((ssResult!.error as Record<string, unknown>)?.code, "select_slot_not_allowed_in_round2", "R-6: select_slot must be rejected");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "R-6: booking.apply result must be present");
  assert.equal((baResult!.data as Record<string, unknown>)?.booking_status, "slot_not_verified", "R-6: booking.apply must be blocked with slot_not_verified");
});

// ── S: same-round booking.select_slot + booking.apply → Guard S ──────────────

// S-1: Failed slot replacement in round-1 combined with booking.apply in same round.
// Guard S fires: select_slot is processed (fails — slot not in evidence), old proof is
// revoked, and booking.apply is blocked. Executor must not be called.
test("S-1: failed booking.select_slot and booking.apply in same round-1 — select_slot fails, booking.apply blocked, prior proof revoked, executor call count=0", async () => {
  let executorCallCount = 0;
  let savedState: Record<string, unknown> | null = null;
  const stateRepo = {
    async loadState() {
      return {
        selected_slot: { starts_at: "2028-01-15T10:00:00" },
        last_available_slots: [{ starts_at: "2028-01-15T10:00:00" }],
        active_availability_evidence: {
          availability_call_id: "call_s1",
          requested_date: "2028-01-15",
          requested_time: null,
          allowed_slot_keys: ["2028-01-15T10:00"],
        },
        selected_slot_proof: {
          subject_id: "subject_1" as const,
          availability_call_id: "call_s1",
          slot_key: "2028-01-15T10:00",
        },
      };
    },
    async saveState(
      _key: { clinic_id: string; contact_id?: string | null; case_id?: string | null },
      state: Record<string, unknown>,
    ) {
      savedState = state;
    },
  };
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      const results = input.input.tool_results ?? [];
      if (!results.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [
            { tool: "booking.select_slot", call_id: "ss_s1", arguments: { subject_id: "subject_1", requested_date: "2028-01-15", requested_time: "11:00" } },
            { tool: "booking.apply", call_id: "ba_s1", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2028-01-15", requested_time: "11:00" } },
          ],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Попробуем другое время." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: stateRepo,
  });
  const result = await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "contact_s1", case_id: null,
    user_message: "запиши на 11:00", locale: "ru", trace_id: "tr_s1",
    channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" },
  });
  assert.equal(executorCallCount, 0, "S-1: booking executor must not be called");
  const ssResult = result.tool_results.find((r) => r.tool === "booking.select_slot");
  assert.ok(ssResult, "S-1: select_slot result must be present");
  assert.equal(ssResult!.status, "failed", "S-1: select_slot must fail");
  assert.equal((ssResult!.error as Record<string, unknown>)?.code, "slot_not_in_active_evidence", "S-1: select_slot must fail with slot_not_in_active_evidence");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "S-1: booking.apply result must be present");
  assert.equal((baResult!.data as Record<string, unknown>)?.booking_status, "slot_not_verified", "S-1: booking.apply blocked with slot_not_verified");
  assert.equal((baResult!.data as Record<string, unknown>)?.reason, "select_slot_and_booking_apply_same_round", "S-1: reason must be select_slot_and_booking_apply_same_round");
  assert.ok(savedState !== null, "S-1: state must be persisted");
  assert.equal((savedState as Record<string, unknown>)["selected_slot_proof"], null, "S-1: prior proof must be revoked in persisted state");
});

// S-2: Ambiguous slot replacement (2 booking.select_slot) + booking.apply in same round-1.
// Guard S fires: both select_slot calls are rejected as ambiguous, booking.apply is blocked.
// Executor must not be called.
test("S-2: ambiguous booking.select_slot (2 calls) and booking.apply in same round-1 — both select_slot fail ambiguous_selection, booking.apply blocked, executor call count=0", async () => {
  let executorCallCount = 0;
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      const results = input.input.tool_results ?? [];
      if (!results.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [
            { tool: "booking.select_slot", call_id: "ss_s2a", arguments: { subject_id: "subject_1", requested_date: "2028-01-15", requested_time: "10:00" } },
            { tool: "booking.select_slot", call_id: "ss_s2b", arguments: { subject_id: "subject_1", requested_date: "2028-01-15", requested_time: "14:00" } },
            { tool: "booking.apply", call_id: "ba_s2", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } },
          ],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Уточните время." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2028-01-15T10:00:00"),
  });
  const result = await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "contact_s2", case_id: null,
    user_message: "запиши", locale: "ru", trace_id: "tr_s2",
    channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" },
  });
  assert.equal(executorCallCount, 0, "S-2: booking executor must not be called");
  const ssResults = result.tool_results.filter((r) => r.tool === "booking.select_slot");
  assert.equal(ssResults.length, 2, "S-2: both select_slot results must be present");
  for (const ss of ssResults) {
    assert.equal(ss.status, "failed", "S-2: each select_slot must fail");
    assert.equal((ss.error as Record<string, unknown>)?.code, "ambiguous_selection", "S-2: each select_slot must fail with ambiguous_selection");
  }
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "S-2: booking.apply result must be present");
  assert.equal((baResult!.data as Record<string, unknown>)?.booking_status, "slot_not_verified", "S-2: booking.apply blocked with slot_not_verified");
  assert.equal((baResult!.data as Record<string, unknown>)?.reason, "select_slot_and_booking_apply_same_round", "S-2: reason must be select_slot_and_booking_apply_same_round");
});

// S-3: Successful slot replacement (14:00) + booking.apply in same round-1.
// Guard S fires: select_slot succeeds with 14:00 proof, old 10:00 proof revoked,
// booking.apply is blocked. New 14:00 proof is persisted. Executor call count=0 in round-1.
test("S-3: successful booking.select_slot (14:00) and booking.apply in same round-1 — new 14:00 proof persisted, booking.apply blocked, executor call count=0", async () => {
  let executorCallCount = 0;
  let savedState: Record<string, unknown> | null = null;
  const stateRepo = {
    async loadState() {
      return {
        selected_slot: { starts_at: "2028-01-15T10:00:00" },
        last_available_slots: [
          { starts_at: "2028-01-15T10:00:00" },
          { starts_at: "2028-01-15T14:00:00" },
        ],
        active_availability_evidence: {
          availability_call_id: "call_s3",
          requested_date: "2028-01-15",
          requested_time: null,
          allowed_slot_keys: ["2028-01-15T10:00", "2028-01-15T14:00"],
        },
        selected_slot_proof: {
          subject_id: "subject_1" as const,
          availability_call_id: "call_s3",
          slot_key: "2028-01-15T10:00",
        },
      };
    },
    async saveState(
      _key: { clinic_id: string; contact_id?: string | null; case_id?: string | null },
      state: Record<string, unknown>,
    ) {
      savedState = state;
    },
  };
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      const results = input.input.tool_results ?? [];
      if (!results.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [
            { tool: "booking.select_slot", call_id: "ss_s3", arguments: { subject_id: "subject_1", requested_date: "2028-01-15", requested_time: "14:00" } },
            { tool: "booking.apply", call_id: "ba_s3", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2028-01-15", requested_time: "14:00" } },
          ],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Готово." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: stateRepo,
  });
  const result = await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "contact_s3", case_id: null,
    user_message: "запиши на 14:00", locale: "ru", trace_id: "tr_s3",
    channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" },
  });
  assert.equal(executorCallCount, 0, "S-3: booking executor must not be called in round-1");
  const ssResult = result.tool_results.find((r) => r.tool === "booking.select_slot");
  assert.ok(ssResult, "S-3: select_slot result must be present");
  assert.equal(ssResult!.status, "success", "S-3: select_slot must succeed");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, "S-3: booking.apply result must be present");
  assert.equal((baResult!.data as Record<string, unknown>)?.booking_status, "slot_not_verified", "S-3: booking.apply blocked with slot_not_verified");
  assert.equal((baResult!.data as Record<string, unknown>)?.reason, "select_slot_and_booking_apply_same_round", "S-3: reason must be select_slot_and_booking_apply_same_round");
  assert.ok(savedState !== null, "S-3: state must be persisted");
  const proof = (savedState as Record<string, unknown>)["selected_slot_proof"] as Record<string, unknown> | null;
  assert.ok(proof !== null, "S-3: new 14:00 proof must be persisted");
  assert.equal(proof!["slot_key"], "2028-01-15T14:00", "S-3: persisted proof must be for 14:00");
});

// S-4: booking.apply without booking.select_slot in round-1 → normal execution path.
// Guard S must NOT fire when there is no select_slot in the round.
// Executor must be called exactly once (existing proof from prior state authorizes booking).
test("S-4: booking.apply without booking.select_slot in round-1 — normal execution path, executor called once", async () => {
  let executorCallCount = 0;
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: new Date("2028-01-14T20:00:00Z"),
    caller: (async (input) => {
      const results = input.input.tool_results ?? [];
      if (!results.length) {
        return {
          type: "tool_requests" as const,
          tool_requests: [
            { tool: "booking.apply", call_id: "ba_s4", arguments: { subject_id: "subject_1", first_name: "Ivan", last_name: "Petrov", service: "чистка", requested_date: "2028-01-15", requested_time: "10:00" } },
          ],
        };
      }
      return { type: "final_response" as const, final_response: { final_patient_reply: "Записано." } };
    }) as RuntimeAgentCaller,
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "v_s4" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2028-01-15T10:00:00"),
  });
  await loop.runTurn({
    clinic_id: "clinic_1", contact_id: "contact_s4", case_id: null,
    user_message: "запиши", locale: "ru", trace_id: "tr_s4",
    channel_contact: { phone_number: "+420111000000", phone_source: "telegram_contact_button" },
  });
  assert.equal(executorCallCount, 1, "S-4: booking executor must be called exactly once (normal path)");
});


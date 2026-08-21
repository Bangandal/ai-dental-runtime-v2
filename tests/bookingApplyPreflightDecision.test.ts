import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBookingApplyPreflight } from "../src/runtime/bookingApplyPreflightDecision.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "../src/runtime/slotEvidence.ts";

const NOW = new Date("2026-08-21T12:00:00Z");
const DATE = "2099-08-21";
const TIME = "14:00";
const SLOT_KEY = `${DATE}T${TIME}`;

const EVIDENCE: AvailabilityEvidence = {
  availability_call_id: "avail_1",
  requested_date: DATE,
  requested_time: TIME,
  allowed_slot_keys: [SLOT_KEY],
  checked_at: "2099-08-21T08:00:00Z",
};
const SELECTED_SLOT = { starts_at: `${DATE}T${TIME}:00+02:00` };
const PROOF: SelectedSlotProof = {
  subject_id: "subject_1",
  availability_call_id: "avail_1",
  slot_key: SLOT_KEY,
};

function request(overrides: Record<string, unknown> = {}): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: "book_1",
    arguments: {
      subject_id: "subject_1",
      first_name: "Eva",
      last_name: "Novak",
      service: "cleaning",
      requested_date: DATE,
      requested_time: TIME,
      ...overrides,
    },
  };
}

function decide(params: Partial<Parameters<typeof evaluateBookingApplyPreflight>[0]> = {}) {
  const pendingBookingApply = params.pendingBookingApply ?? request();
  return evaluateBookingApplyPreflight({
    round: 2,
    pendingBookingApply,
    pendingToolRequests: params.pendingToolRequests ?? [pendingBookingApply],
    pendingTypedPhone: false,
    hasBookingPhone: true,
    activeAvailabilityEvidence: EVIDENCE,
    selectedSlot: SELECTED_SLOT,
    selectedSlotProof: PROOF,
    includeInvalidSlotGuard: true,
    timezone: "Europe/Prague",
    now: NOW,
    ...params,
  });
}

test("R2e: fully proven booking passes shared preflight", () => {
  assert.deepEqual(decide(), { outcome: "allow" });
});

test("R2e: pending typed-phone ownership has highest shared-preflight priority", () => {
  const pendingBookingApply = request({ requested_date: null, requested_time: null });
  const result = decide({ pendingBookingApply, pendingToolRequests: [pendingBookingApply], pendingTypedPhone: true, hasBookingPhone: false });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "pending_phone_classification");
  assert.equal(result.debug_reason, "booking_apply_preflight_pending_typed_phone_round2");
});

test("R2e: past time wins before slot-format/proof guards and preserves diagnostics", () => {
  const pendingBookingApply = request({
    requested_date: "2026-08-21",
    requested_time: "10:00",
  });
  const result = decide({ pendingBookingApply, pendingToolRequests: [pendingBookingApply] });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "past_time");
  assert.equal(result.debug_reason, "booking_apply_preflight_past_time_round2");
  assert.equal(result.past_time_detail?.todayInTimezone, "2026-08-21");
});

test("R2e: malformed or missing slot blocks before phone/name/service", () => {
  const pendingBookingApply = request({ requested_time: "9:00" });
  const result = decide({ pendingBookingApply, pendingToolRequests: [pendingBookingApply], hasBookingPhone: false });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "missing_slot");
});

test("R2e: absent selected-slot proof blocks before phone", () => {
  const result = decide({ selectedSlotProof: null, hasBookingPhone: false });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "slot_not_verified");
  assert.equal(result.guarded_data.reason, "slot_proof_required");
});

test("R2e: round-2 invalid-slot guard stays after proof-absence guard", () => {
  const pendingBookingApply = request({ requested_time: "15:00" });
  const result = decide({
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    selectedSlot: { starts_at: `${DATE}T15:00:00+02:00` },
    selectedSlotProof: { ...PROOF, slot_key: `${DATE}T15:00` },
  });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "invalid_slot");
  assert.equal(result.debug_reason, "booking_apply_preflight_invalid_slot_round2");
});

test("R2e: round-1 preserves historical behavior without the round-2 invalid-slot guard", () => {
  const pendingBookingApply = request({ requested_time: "15:00" });
  const result = decide({
    round: 1,
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    selectedSlot: { starts_at: `${DATE}T15:00:00+02:00` },
    selectedSlotProof: { ...PROOF, slot_key: `${DATE}T15:00` },
    includeInvalidSlotGuard: false,
  });
  assert.deepEqual(result, { outcome: "allow" });
});

test("R2e: phone guard runs before missing-name and missing-service guards", () => {
  const pendingBookingApply = request({ first_name: "", last_name: "", service: "" });
  const result = decide({ pendingBookingApply, pendingToolRequests: [pendingBookingApply], hasBookingPhone: false });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "missing_trusted_phone");
  assert.equal(result.debug_reason, "booking_apply_intercepted_missing_trusted_phone");
});

test("R2e: missing names preserve exact missing_fields after phone is available", () => {
  const pendingBookingApply = request({ first_name: "", last_name: "" });
  const result = decide({ pendingBookingApply, pendingToolRequests: [pendingBookingApply] });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "missing_patient_name");
  assert.deepEqual(result.missing_fields, ["first_name", "last_name"]);
  assert.deepEqual(result.guarded_data.missing_fields, ["first_name", "last_name"]);
});

test("R2e: missing service is the last shared preflight before allow", () => {
  const pendingBookingApply = request({ service: "" });
  const result = decide({ pendingBookingApply, pendingToolRequests: [pendingBookingApply] });
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guarded_data.booking_status, "missing_service");
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateBookingApplyPreflightPolicy } from "../src/runtime/bookingApplyPreflightPolicy.ts";
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

function decide(params: Partial<Parameters<typeof evaluateBookingApplyPreflightPolicy>[0]> = {}) {
  const pendingBookingApply = params.pendingBookingApply ?? request();
  return evaluateBookingApplyPreflightPolicy({
    pendingBookingApply,
    pendingToolRequests: params.pendingToolRequests ?? [pendingBookingApply],
    pendingTypedPhone: false,
    hasBookingPhone: true,
    activeAvailabilityEvidence: EVIDENCE,
    selectedSlot: SELECTED_SLOT,
    selectedSlotProof: PROOF,
    timezone: "Europe/Prague",
    now: NOW,
    ...params,
  });
}

test("R3j: fully proven booking passes roundless business policy", () => {
  assert.deepEqual(decide(), { outcome: "allow" });
});

test("R3j: pending typed phone remains highest business-preflight priority", () => {
  const pendingBookingApply = request({ requested_date: null, requested_time: null });
  const result = decide({
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    pendingTypedPhone: true,
    hasBookingPhone: false,
  });

  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guard_code, "pending_typed_phone");
  assert.equal(result.guarded_data.booking_status, "pending_phone_classification");
});

test("R3j: past-time guard preserves business diagnostics without transport phase", () => {
  const pendingBookingApply = request({
    requested_date: "2026-08-21",
    requested_time: "10:00",
  });
  const result = decide({ pendingBookingApply, pendingToolRequests: [pendingBookingApply] });

  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guard_code, "past_time");
  assert.equal(result.guarded_data.booking_status, "past_time");
  assert.equal(result.past_time_detail?.todayInTimezone, "2026-08-21");
});

test("R3o: proof-backed slot outside active authoritative evidence always fails closed", () => {
  const pendingBookingApply = request({ requested_time: "15:00" });
  const result = decide({
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    selectedSlot: { starts_at: `${DATE}T15:00:00+02:00` },
    selectedSlotProof: { ...PROOF, slot_key: `${DATE}T15:00` },
  });

  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") return;
  assert.equal(result.guard_code, "invalid_slot");
  assert.equal(result.guarded_data.booking_status, "invalid_slot");
  assert.equal(result.guarded_data.reason, "requested_time_not_in_available_slots");
});

test("R3j: phone, name, and service ordering remains business-owned", () => {
  const pendingBookingApply = request({ first_name: "", last_name: "", service: "" });

  const noPhone = decide({
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    hasBookingPhone: false,
  });
  assert.equal(noPhone.outcome, "block");
  if (noPhone.outcome !== "block") return;
  assert.equal(noPhone.guard_code, "missing_trusted_phone");

  const missingName = decide({
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    hasBookingPhone: true,
  });
  assert.equal(missingName.outcome, "block");
  if (missingName.outcome !== "block") return;
  assert.equal(missingName.guard_code, "missing_name");
  assert.deepEqual(missingName.missing_fields, ["first_name", "last_name"]);

  const missingServiceRequest = request({ service: "" });
  const missingService = decide({
    pendingBookingApply: missingServiceRequest,
    pendingToolRequests: [missingServiceRequest],
  });
  assert.equal(missingService.outcome, "block");
  if (missingService.outcome !== "block") return;
  assert.equal(missingService.guard_code, "missing_service");
});

test("R3j: legacy adapter preserves old round-shaped diagnostics without changing business outcome", () => {
  const pendingBookingApply = request({ service: "" });
  const policy = decide({
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
  });
  const legacy = evaluateBookingApplyPreflight({
    round: 2,
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    pendingTypedPhone: false,
    hasBookingPhone: true,
    activeAvailabilityEvidence: EVIDENCE,
    selectedSlot: SELECTED_SLOT,
    selectedSlotProof: PROOF,
    timezone: "Europe/Prague",
    now: NOW,
  });

  assert.equal(policy.outcome, "block");
  assert.equal(legacy.outcome, "block");
  if (policy.outcome !== "block" || legacy.outcome !== "block") return;
  assert.deepEqual(legacy.guarded_data, policy.guarded_data);
  assert.deepEqual(legacy.missing_fields, policy.missing_fields);
  assert.deepEqual(legacy.past_time_detail, policy.past_time_detail);
  assert.equal(legacy.debug_reason, "booking_apply_preflight_missing_service_round2");
});

test("R3o: adapter round changes diagnostics only, never invalid-slot legality", () => {
  const pendingBookingApply = request({ requested_time: "15:00" });
  const common = {
    pendingBookingApply,
    pendingToolRequests: [pendingBookingApply],
    pendingTypedPhone: false,
    hasBookingPhone: true,
    activeAvailabilityEvidence: EVIDENCE,
    selectedSlot: { starts_at: `${DATE}T15:00:00+02:00` },
    selectedSlotProof: { ...PROOF, slot_key: `${DATE}T15:00` },
    timezone: "Europe/Prague",
    now: NOW,
  };

  const first = evaluateBookingApplyPreflight({ round: 1, ...common });
  const second = evaluateBookingApplyPreflight({ round: 2, ...common });

  assert.equal(first.outcome, "block");
  assert.equal(second.outcome, "block");
  if (first.outcome !== "block" || second.outcome !== "block") return;
  assert.deepEqual(first.guarded_data, second.guarded_data);
  assert.equal(first.debug_reason, "booking_apply_preflight_invalid_slot_round1");
  assert.equal(second.debug_reason, "booking_apply_preflight_invalid_slot_round2");
});

test("R3o structure: business preflight has no model-call or membership-compatibility knob", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const policySource = await readFile(resolve(thisDir, "../src/runtime/bookingApplyPreflightPolicy.ts"), "utf8");
  const adapterSource = await readFile(resolve(thisDir, "../src/runtime/bookingApplyPreflightDecision.ts"), "utf8");

  assert.doesNotMatch(policySource, /params\.round/);
  assert.doesNotMatch(policySource, /round:\s*1\s*\|\s*2/);
  assert.doesNotMatch(policySource, /_round[12]/);
  assert.doesNotMatch(policySource, /booking_apply_intercepted_missing_trusted_phone/);
  assert.doesNotMatch(policySource, /enforceSelectedSlotMembership/);
  assert.doesNotMatch(adapterSource, /includeInvalidSlotGuard/);
  assert.match(policySource, /shouldInterceptInvalidSlotDateTime\(slotEvidenceParams\)/);
  assert.match(policySource, /guard_code/);
});

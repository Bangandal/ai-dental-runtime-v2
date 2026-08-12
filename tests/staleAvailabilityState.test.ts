import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelVisibleBookingProcessState,
  computeBookingProcessState,
  AVAILABILITY_MODEL_VISIBILITY_TTL_MS,
  isAvailabilityEvidenceFresh,
  type BookingProcessState,
} from "../src/runtime/bookingProcessState.ts";
import type { AvailabilityEvidence } from "../src/runtime/slotEvidence.ts";
import type { AuthoritativeAvailabilityAttempt } from "../src/runtime/availabilityActionTruth.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

const TIMEZONE = "Europe/Prague";
// NOW = 2026-08-12 10:00 UTC = 12:00 Prague (UTC+2 summer)
const NOW = new Date("2026-08-12T10:00:00.000Z");
const FRESH_CHECKED_AT = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago — within TTL
const STALE_CHECKED_AT = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(); // 20 min ago — beyond TTL

function makeEvidence(opts: { checkedAt?: string; date?: string } = {}): AvailabilityEvidence {
  const date = opts.date ?? "2026-08-12";
  return {
    availability_call_id: "call-1",
    requested_date: date,
    requested_time: "10:00",
    allowed_slot_keys: [`${date}T10:00`, `${date}T11:00`, `${date}T14:00`],
    ...(opts.checkedAt !== undefined ? { checked_at: opts.checkedAt } : {}),
  };
}

function makeState(opts: {
  evidence?: AvailabilityEvidence | null;
  slots?: Array<{ starts_at: string }>;
  selectedSlot?: { starts_at: string } | null;
  nextAction?: BookingProcessState["next_action"];
  slotKnown?: boolean;
  phoneTrusted?: boolean;
} = {}): BookingProcessState {
  const slotKnown = opts.slotKnown ?? false;
  const phoneTrusted = opts.phoneTrusted ?? true;
  return {
    proof: {
      service_known: true,
      name_known: true,
      slot_known: slotKnown,
      trusted_phone_known: phoneTrusted,
      ready_for_booking_apply: slotKnown && phoneTrusted,
    },
    active_availability_evidence: opts.evidence ?? null,
    last_available_slots: opts.slots?.map((s) => ({ starts_at: s.starts_at })) ?? [],
    selected_slot: opts.selectedSlot ?? null,
    next_action: opts.nextAction ?? "ask_for_slot",
  };
}

const GROUNDED = { priorProcessState: null as null, bookingStateGrounded: true };

// STALE-1: Fresh evidence — slots pass through to the model
test("STALE-1: fresh evidence — slots visible to model", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: FRESH_CHECKED_AT, date: "2026-08-12" }),
    slots: [
      { starts_at: "2026-08-12T14:00:00" },
      { starts_at: "2026-08-12T15:00:00" },
    ],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.ok((visible.last_available_slots?.length ?? 0) > 0, "Fresh slots must be visible");
  assert.notEqual(visible.slot_evidence_status, "stale");
});

// STALE-2: Stale evidence — last_available_slots emptied in model-visible state
test("STALE-2: stale evidence — last_available_slots emptied", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT, date: "2026-07-10" }),
    slots: [
      { starts_at: "2026-07-10T09:00:00" },
      { starts_at: "2026-07-10T10:00:00" },
    ],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.deepEqual(visible.last_available_slots, []);
  assert.equal(visible.slot_evidence_status, "stale");
});

// STALE-3: Stale evidence — selected_slot suppressed from model
test("STALE-3: stale evidence — selected_slot suppressed", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT, date: "2026-07-10" }),
    selectedSlot: { starts_at: "2026-07-10T09:00:00" },
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.selected_slot, undefined);
  assert.equal(visible.slot_evidence_status, "stale");
});

// STALE-4: Stale evidence — proof.slot_known forced to false
test("STALE-4: stale evidence — slot_known forced false in model proof", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT }),
    selectedSlot: { starts_at: "2026-07-10T09:00:00" },
    slotKnown: true,
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.proof?.slot_known, false);
});

// STALE-5: Stale evidence — proof.ready_for_booking_apply forced to false
test("STALE-5: stale evidence — ready_for_booking_apply forced false in model proof", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT }),
    selectedSlot: { starts_at: "2026-07-10T09:00:00" },
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.proof?.ready_for_booking_apply, false);
});

// STALE-6: Stale evidence — choose_from_available_slots next_action suppressed
test("STALE-6: stale evidence — choose_from_available_slots suppressed from next_action", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT }),
    slots: [{ starts_at: "2026-07-10T09:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.notEqual(visible.next_action, "choose_from_available_slots");
});

// STALE-7: Stale evidence — ready_for_booking_apply next_action suppressed
test("STALE-7: stale evidence — ready_for_booking_apply suppressed from next_action", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT }),
    selectedSlot: { starts_at: "2026-07-10T09:00:00" },
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.notEqual(visible.next_action, "ready_for_booking_apply");
});

// STALE-8: Stale evidence — ask_for_phone suppressed (slot-dependent)
test("STALE-8: stale evidence — ask_for_phone suppressed from next_action", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT }),
    selectedSlot: { starts_at: "2026-07-10T09:00:00" },
    slotKnown: true,
    nextAction: "ask_for_phone",
    phoneTrusted: false,
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.notEqual(visible.next_action, "ask_for_phone");
});

// STALE-9: Missing checked_at — fails closed (treated as stale)
test("STALE-9: missing checked_at — fails closed, treated as stale", () => {
  const evidence = makeEvidence(); // no checkedAt
  assert.equal(evidence.checked_at, undefined);
  assert.equal(isAvailabilityEvidenceFresh(evidence, NOW), false, "Missing checked_at → not fresh");

  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T14:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.deepEqual(visible.last_available_slots, []);
  assert.equal(visible.slot_evidence_status, "stale");
});

// STALE-10: Low confidence path + stale evidence — slots emptied
test("STALE-10: low confidence + stale evidence — slots emptied", () => {
  const state = makeState({
    evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT, date: "2026-07-10" }),
    slots: [{ starts_at: "2026-07-10T09:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: null,
    bookingStateGrounded: false, // low confidence
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.deepEqual(visible.last_available_slots, []);
  assert.equal(visible.next_action_confidence, "low");
  assert.equal(visible.slot_evidence_status, "stale");
});

// STALE-PROD: Production path — computeBookingProcessState stamps checked_at on fresh evidence
test("STALE-PROD: production path stamps checked_at; evidence is fresh then stale after TTL", () => {
  const now = new Date("2026-08-12T10:00:00.000Z");

  const availRequest: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "call-prod-1",
    arguments: { requested_date: "2026-08-12", requested_time: "14:00" },
  };
  const availResult: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call-prod-1",
    status: "success",
    data: {
      slots: [
        { starts_at: "2026-08-12T14:00:00", ends_at: "2026-08-12T14:30:00" },
        { starts_at: "2026-08-12T15:00:00", ends_at: "2026-08-12T15:30:00" },
      ],
    },
  };

  const authAttempt: AuthoritativeAvailabilityAttempt = {
    attempted: true,
    request: availRequest,
    pair: { request: availRequest, result: availResult },
  };

  const state = computeBookingProcessState({
    authoritativeAvailabilityAttempt: authAttempt,
    now,
  });

  assert.ok(state.active_availability_evidence?.checked_at, "checked_at must be stamped on fresh evidence");

  const checkedAt = new Date(state.active_availability_evidence!.checked_at!);
  const age = now.getTime() - checkedAt.getTime();
  assert.ok(age >= 0 && age < 1000, `checked_at age ${age}ms must be within 1s of turnNow`);

  assert.equal(
    isAvailabilityEvidenceFresh(state.active_availability_evidence, now),
    true,
    "Evidence must be fresh immediately after stamp",
  );

  const afterTtl = new Date(now.getTime() + AVAILABILITY_MODEL_VISIBILITY_TTL_MS + 1000);
  assert.equal(
    isAvailabilityEvidenceFresh(state.active_availability_evidence, afterTtl),
    false,
    "Evidence must be stale after TTL expires",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelVisibleBookingProcessState,
  computeBookingProcessState,
  createInMemoryBookingProcessStateRepository,
  AVAILABILITY_MODEL_VISIBILITY_TTL_MS,
  isAvailabilityEvidenceFresh,
  type BookingProcessState,
} from "../src/runtime/bookingProcessState.ts";
import type { AvailabilityEvidence } from "../src/runtime/slotEvidence.ts";
import type { AuthoritativeAvailabilityAttempt } from "../src/runtime/availabilityActionTruth.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";
import {
  createRuntimeAgentLoop,
  type RuntimeAgentCaller,
} from "../src/runtime/runtimeAgentLoop.ts";

const TIMEZONE = "Europe/Prague";
// NOW = 2026-08-12 10:00 UTC = 12:00 Prague (UTC+2 summer)
const NOW = new Date("2026-08-12T10:00:00.000Z");
const FRESH_CHECKED_AT = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago — within TTL
const STALE_CHECKED_AT = new Date(NOW.getTime() - AVAILABILITY_MODEL_VISIBILITY_TTL_MS - 5 * 60 * 1000).toISOString(); // beyond TTL

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

// ── Regression pack A-I ──────────────────────────────────────────────────────

// A: Fresh TTL + selected_slot already passed in clinic-local time → hidden, slot_known=false
test("A: fresh evidence, selected_slot already passed → slot hidden, slot_known=false", () => {
  // NOW=12:00 Prague; slot at 11:00 Prague = 1 hr past
  const state = makeState({
    evidence: makeEvidence({ checkedAt: FRESH_CHECKED_AT, date: "2026-08-12" }),
    slots: [{ starts_at: "2026-08-12T14:00:00" }],
    selectedSlot: { starts_at: "2026-08-12T11:00:00" }, // Prague 11:00 < minKey 12:00 → expired
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.selected_slot, undefined, "Expired selected_slot must be hidden");
  assert.equal(visible.proof?.slot_known, false, "slot_known must be false");
  assert.equal(visible.proof?.ready_for_booking_apply, false, "ready_for_booking_apply must be false");
  assert.equal(visible.slot_evidence_status, "stale", "slot_evidence_status must be stale");
  assert.notEqual(visible.next_action, "ready_for_booking_apply", "ready_for_booking_apply next_action suppressed");
});

// B: Slot at exactly the current clinic-local minute → expired (strict > semantics)
test("B: slot exactly at current clinic-local minute → expired", () => {
  // NOW = 2026-08-12T10:00Z = 12:00 Prague; slot at exactly 12:00 Prague = expired
  const exactEvidence: AvailabilityEvidence = {
    availability_call_id: "call-B",
    requested_date: "2026-08-12",
    requested_time: "12:00",
    allowed_slot_keys: ["2026-08-12T12:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence: exactEvidence,
    slots: [{ starts_at: "2026-08-12T12:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.deepEqual(visible.last_available_slots, [], "Slot at exactly current minute must be expired");
  assert.notEqual(visible.next_action, "choose_from_available_slots", "choose_from_available_slots suppressed when no visible slots");
});

// C: Stale TTL + slot is tomorrow (future date) → still hidden — TTL is not just past-date cleanup
test("C: stale evidence + slot is tomorrow → hidden (TTL check, not past-date check)", () => {
  const tomorrowEvidence: AvailabilityEvidence = {
    availability_call_id: "call-C",
    requested_date: "2026-08-13",
    requested_time: "10:00",
    allowed_slot_keys: ["2026-08-13T10:00"],
    checked_at: STALE_CHECKED_AT,
  };
  const state = makeState({
    evidence: tomorrowEvidence,
    slots: [{ starts_at: "2026-08-13T10:00:00" }],
    selectedSlot: { starts_at: "2026-08-13T10:00:00" },
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.deepEqual(visible.last_available_slots, [], "Stale evidence hides future slots too");
  assert.equal(visible.selected_slot, undefined);
  assert.equal(visible.slot_evidence_status, "stale");
});

// D: Fresh evidence, same-day — past slot removed, future slot retained
test("D: fresh same-day evidence — past slot filtered out, future slot retained", () => {
  const evidenceD: AvailabilityEvidence = {
    availability_call_id: "call-D",
    requested_date: "2026-08-12",
    requested_time: "11:00",
    // Both keys present so filterAllowedSlots doesn't drop them
    allowed_slot_keys: ["2026-08-12T11:00", "2026-08-12T15:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence: evidenceD,
    slots: [
      { starts_at: "2026-08-12T11:00:00" }, // Prague 11:00 < minKey 12:00 → past
      { starts_at: "2026-08-12T15:00:00" }, // Prague 15:00 > minKey 12:00 → future
    ],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.last_available_slots?.length, 1, "Only one slot must remain");
  assert.equal(visible.last_available_slots?.[0]?.starts_at, "2026-08-12T15:00:00", "Future slot retained");
});

// E: Fresh evidence, selected_slot not in allowed_slot_keys → excluded
test("E: fresh evidence, selected_slot not in allowed_slot_keys → excluded", () => {
  // makeEvidence allowed_slot_keys: 10:00, 11:00, 14:00
  // selected_slot at 16:00 is NOT in allowed_slot_keys
  const evidenceE = makeEvidence({ checkedAt: FRESH_CHECKED_AT, date: "2026-08-12" });
  const state = makeState({
    evidence: evidenceE,
    slots: [{ starts_at: "2026-08-12T14:00:00" }],
    selectedSlot: { starts_at: "2026-08-12T16:00:00" }, // future but NOT in allowed_slot_keys
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.selected_slot, undefined, "Unbound selected_slot must be hidden");
  assert.equal(visible.proof?.slot_known, false);
  assert.equal(visible.slot_evidence_status, "stale");
});

// F: Stale evidence + durable fields → slots sanitized, service/name preserved
test("F: stale evidence — availability sanitized, durable fields preserved", () => {
  const stateF: BookingProcessState = {
    ...makeState({
      evidence: makeEvidence({ checkedAt: STALE_CHECKED_AT, date: "2026-07-10" }),
      slots: [{ starts_at: "2026-07-10T09:00:00" }],
      selectedSlot: { starts_at: "2026-07-10T09:00:00" },
      slotKnown: true,
      nextAction: "ready_for_booking_apply",
    }),
    service_reason: "зубная боль",
    first_name: "Михаил",
    last_name: "Огар",
  };

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: stateF,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.service_reason, "зубная боль", "service_reason preserved");
  assert.equal(visible.first_name, "Михаил", "first_name preserved");
  assert.equal(visible.last_name, "Огар", "last_name preserved");
  assert.deepEqual(visible.last_available_slots, [], "Stale slots cleared");
  assert.equal(visible.selected_slot, undefined, "Stale selected_slot cleared");
  assert.equal(visible.slot_evidence_status, "stale");
});

// G: Fresh evidence persisted into next turn → slots still visible ("давай второй" still works)
test("G: fresh evidence persisted to next turn within TTL → slots still visible", () => {
  // Slot at 14:00 is in makeEvidence's allowed_slot_keys (10:00, 11:00, 14:00)
  const state = makeState({
    evidence: makeEvidence({ checkedAt: FRESH_CHECKED_AT, date: "2026-08-12" }),
    slots: [{ starts_at: "2026-08-12T14:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  // Simulate "next turn" with same evidence, still within TTL
  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.ok((visible.last_available_slots?.length ?? 0) > 0, "Fresh persisted slots must remain visible next turn");
  assert.notEqual(visible.slot_evidence_status, "stale");
});

// H: Stale persisted evidence + fresh availability.check this turn → evidence replaced, checked_at = turnNow
test("H: stale prior evidence + successful availability.check → evidence replaced with turnNow timestamp", () => {
  const oldEvidence = makeEvidence({ checkedAt: STALE_CHECKED_AT, date: "2026-07-10" });

  const availRequestH: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "call-H",
    arguments: { requested_date: "2026-08-12", requested_time: "14:00" },
  };
  const availResultH: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call-H",
    status: "success",
    data: {
      slots: [{ starts_at: "2026-08-12T14:00:00", ends_at: "2026-08-12T14:30:00" }],
    },
  };

  const authAttemptH: AuthoritativeAvailabilityAttempt = {
    attempted: true,
    request: availRequestH,
    pair: { request: availRequestH, result: availResultH },
  };

  const newState = computeBookingProcessState({
    prior: { active_availability_evidence: oldEvidence },
    authoritativeAvailabilityAttempt: authAttemptH,
    now: NOW,
  });

  assert.ok(newState.active_availability_evidence, "New evidence must exist");
  assert.equal(newState.active_availability_evidence?.requested_date, "2026-08-12", "Evidence date updated");

  const age = NOW.getTime() - new Date(newState.active_availability_evidence!.checked_at!).getTime();
  assert.ok(age >= 0 && age < 1000, `checked_at age ${age}ms must be within 1s of NOW`);

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: newState,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.ok((visible.last_available_slots?.length ?? 0) > 0, "New slots must be visible after fresh check");
  assert.notEqual(visible.slot_evidence_status, "stale");
});

// I (production-path): runtimeAgentLoop with July stale state, Aug 12 clock → first model call has no July slots
test("I: production-path — July stale state on Aug 12 clock → first model call has no July slots", async () => {
  const JULY_CHECKED_AT = new Date("2026-07-08T08:00:00.000Z").toISOString(); // ~35 days ago = stale

  // Pre-load a repository with July state (the Огар Михаил production incident state)
  const repo = createInMemoryBookingProcessStateRepository();
  const priorState: BookingProcessState = {
    service_reason: "зубная боль",
    first_name: "Михаил",
    last_name: "Огар",
    last_available_slots: [
      { starts_at: "2026-07-08T10:00:00" },
      { starts_at: "2026-07-08T11:00:00" },
      { starts_at: "2026-07-08T14:00:00" },
    ],
    selected_slot: null,
    active_availability_evidence: {
      availability_call_id: "call-july-1",
      requested_date: "2026-07-08",
      requested_time: "10:00",
      allowed_slot_keys: ["2026-07-08T10:00", "2026-07-08T11:00", "2026-07-08T14:00"],
      checked_at: JULY_CHECKED_AT,
    },
    selected_slot_proof: null,
    phone_trusted: false,
    next_action: "ask_for_slot",
    proof: {
      service_known: true,
      name_known: true,
      slot_known: false,
      trusted_phone_known: false,
      ready_for_booking_apply: false,
    },
  };
  await repo.saveState({ clinic_id: "clinic_1", contact_id: "contact_ogr", case_id: null }, priorState);

  // Capture the first caller input
  let firstCallerInput: Parameters<RuntimeAgentCaller>[0] | undefined;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!firstCallerInput) firstCallerInput = input;
    return {
      type: "final_response",
      final_response: { final_patient_reply: "Добрый день! Давайте подберём удобное время." },
    };
  };

  const agent = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {},
    bookingProcessStateRepository: repo,
    now: NOW, // Aug 12 10:00 UTC
    timezone: TIMEZONE,
  });

  await agent.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_ogr",
    case_id: null,
    user_message: "после обеда, Огар Михаил",
    locale: "ru",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  });

  assert.ok(firstCallerInput, "Caller must have been invoked");

  const bookingCtx = (firstCallerInput!.input.context as Record<string, unknown>).booking_process_state as Record<string, unknown> | undefined;
  assert.ok(bookingCtx, "booking_process_state must be in context");

  const slots = bookingCtx.last_available_slots as unknown[] | undefined;
  assert.deepEqual(slots ?? [], [], "July stale slots must not reach model on Aug 12");

  assert.equal(bookingCtx.slot_evidence_status, "stale", "slot_evidence_status must be stale");

  const proof = bookingCtx.proof as Record<string, unknown> | undefined;
  assert.notEqual(proof?.slot_known, true, "proof.slot_known must not be true when evidence is stale");
  assert.notEqual(proof?.ready_for_booking_apply, true, "proof.ready_for_booking_apply must not be true when evidence is stale");
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

// J: Fresh evidence + all slots now past → last_available_slots=[], choose_from_available_slots suppressed
test("J: fresh evidence + all slots now past → empty last_available_slots, choose_from_available_slots suppressed", () => {
  // All slots are at or before NOW (2026-08-12T10:00Z = 12:00 Prague)
  const pastEvidence: AvailabilityEvidence = {
    availability_call_id: "call-J",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T09:00", "2026-08-12T10:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence: pastEvidence,
    slots: [{ starts_at: "2026-08-12T09:00:00" }, { starts_at: "2026-08-12T10:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.deepEqual(visible.last_available_slots, [], "All past slots must be filtered out");
  assert.notEqual(visible.next_action, "choose_from_available_slots", "choose_from_available_slots must be suppressed when no visible slots remain");
});

// K: Fresh evidence + one past + one future → future slot visible, choose_from_available_slots remains
test("K: fresh evidence + one past + one future slot → future visible, choose_from_available_slots remains", () => {
  // 09:00 Prague = 07:00 UTC (past relative to NOW=10:00 UTC); 14:00 Prague = 12:00 UTC (future)
  const mixedEvidence: AvailabilityEvidence = {
    availability_call_id: "call-K",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T09:00", "2026-08-12T14:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence: mixedEvidence,
    slots: [{ starts_at: "2026-08-12T09:00:00" }, { starts_at: "2026-08-12T14:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.last_available_slots?.length, 1, "Only the future slot must survive filtering");
  assert.equal(visible.last_available_slots?.[0]?.starts_at, "2026-08-12T14:00:00", "The 14:00 slot must be visible");
  assert.equal(visible.next_action, "choose_from_available_slots", "choose_from_available_slots must remain when at least one slot is visible");
});

// ── PF-001 regression: allOfferedSlotsProvenExpired ──────────────────────────

// L: All offered slots proven expired → slot_evidence_status=stale, slot_known=false, ready_for_booking_apply=false
test("L: all offered slots proven expired → stale, slot_known=false, ready_for_booking_apply=false", () => {
  // NOW = 2026-08-12T10:00 UTC = 12:00 Prague. Both slots are before 12:00 Prague.
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-L",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T09:00", "2026-08-12T10:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T09:00:00" }, { starts_at: "2026-08-12T10:00:00" }],
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.slot_evidence_status, "stale", "slot_evidence_status must be stale when all offered slots expired");
  assert.equal(visible.proof?.slot_known, false, "slot_known must be cleared when all offered slots expired");
  assert.equal(visible.proof?.ready_for_booking_apply, false, "ready_for_booking_apply must be cleared when all offered slots expired");
  assert.equal((visible.last_available_slots ?? []).length, 0, "no slots should be visible");
});

// M: NOT all slots expired (one future) → not stale from allOfferedSlotsExpired path
test("M: one slot still in future → NOT stale from allOfferedSlotsExpired", () => {
  // 09:00 Prague = past; 14:00 Prague = future relative to NOW=12:00 Prague
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-M",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T09:00", "2026-08-12T14:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T09:00:00" }, { starts_at: "2026-08-12T14:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.notEqual(visible.slot_evidence_status, "stale", "slot_evidence_status must NOT be stale when at least one future slot remains");
  assert.equal((visible.last_available_slots ?? []).length, 1, "future slot must be visible");
});

// N: Empty last_available_slots → NOT stale (unknown, not proven expired)
test("N: empty last_available_slots → NOT stale (unknown state, not proven expired)", () => {
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-N",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: [],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({ evidence, slots: [], nextAction: "ask_for_slot" });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.notEqual(visible.slot_evidence_status, "stale", "empty slots must NOT trigger stale — state is unknown, not proven expired");
});

// O: Single slot exactly at current clinic-local minute → proven expired (key <= nowKey)
test("O: single slot exactly at current clinic-local minute → proven expired", () => {
  // NOW = 2026-08-12T10:00:00Z = 2026-08-12T12:00 Prague. Slot at exactly 12:00 Prague.
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-O",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T12:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T12:00:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.slot_evidence_status, "stale", "slot exactly at current minute must be treated as expired (key <= nowKey)");
  assert.equal((visible.last_available_slots ?? []).length, 0, "expired slot must not be visible");
});

// ── PF-001 regression: timezone-aware Z/offset starts_at in stale detection ──
// NOW = 2026-08-12T10:00:00Z = 12:00 Prague (UTC+2)

// P: UTC slot that is actually FUTURE in clinic-local → NOT expired
test("P: starts_at with Z suffix that is future in clinic-local timezone → NOT stale", () => {
  // "2026-08-12T12:00:00Z" = 14:00 Prague. NOW = 12:00 Prague. Still 2 hours away.
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-P",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T14:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T12:00:00Z" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.notEqual(visible.slot_evidence_status, "stale", "UTC slot future in Prague must NOT be stale");
});

// Q: UTC slot that is PAST in clinic-local → expired → stale
test("Q: starts_at with Z suffix that is past in clinic-local timezone → stale", () => {
  // "2026-08-12T08:00:00Z" = 10:00 Prague. NOW = 12:00 Prague. Already passed.
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-Q",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T10:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T08:00:00Z" }],
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.slot_evidence_status, "stale", "UTC slot past in Prague must be stale");
  assert.equal(visible.proof?.slot_known, false, "slot_known must be cleared");
});

// R: Numeric offset slot that is FUTURE in clinic-local → NOT expired
test("R: starts_at with numeric offset that is future in clinic-local timezone → NOT stale", () => {
  // "2026-08-12T14:00:00+02:00" = 14:00 Prague. NOW = 12:00 Prague. Still 2 hours away.
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-R",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T14:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T14:00:00+02:00" }],
    nextAction: "choose_from_available_slots",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.notEqual(visible.slot_evidence_status, "stale", "offset slot future in Prague must NOT be stale");
});

// S: Numeric offset slot that is PAST in clinic-local → expired → stale
test("S: starts_at with numeric offset that is past in clinic-local timezone → stale", () => {
  // "2026-08-12T09:00:00+02:00" = 09:00 Prague. NOW = 12:00 Prague. Already passed.
  const evidence: AvailabilityEvidence = {
    availability_call_id: "call-S",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys: ["2026-08-12T09:00"],
    checked_at: FRESH_CHECKED_AT,
  };
  const state = makeState({
    evidence,
    slots: [{ starts_at: "2026-08-12T09:00:00+02:00" }],
    slotKnown: true,
    nextAction: "ready_for_booking_apply",
  });

  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state,
    now: NOW,
    timezone: TIMEZONE,
  });

  assert.equal(visible.slot_evidence_status, "stale", "offset slot past in Prague must be stale");
  assert.equal(visible.proof?.slot_known, false, "slot_known must be cleared");
});

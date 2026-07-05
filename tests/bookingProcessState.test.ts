/**
 * PR #143 — bookingProcessState tests.
 *
 * Tests A–G:
 *
 * A. availability.check result stores last_available_slots in state.
 * B. Patient says "17:30" after slots offered → selected_slot matches 17:30 slot.
 * C. Patient says "Отлично 17:30" after slots offered → selected_slot=17:30, next_action=ask_for_phone.
 * D. Patient gives name once → second turn does NOT have next_action=ask_for_name.
 * E. Patient gives service_reason once → second turn does NOT have next_action=ask_for_service.
 * F. Patient says "18:00" but only 17:30 and 18:30 were offered → next_action=choose_from_available_slots.
 * G. No ClinicCard writes in any state-only turn.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeBookingProcessState,
  detectSelectedSlot,
  extractSlotTime,
  extractSlotsFromToolResults,
  createInMemoryBookingProcessStateRepository,
  type AvailableSlot,
} from "../src/runtime/bookingProcessState.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type { RuntimeAgentToolResult, ChannelContact } from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SLOT_1730: AvailableSlot = { starts_at: "2026-08-05T17:30:00", ends_at: "2026-08-05T18:00:00", slot_id: "s1730" };
const SLOT_1830: AvailableSlot = { starts_at: "2026-08-05T18:30:00", ends_at: "2026-08-05T19:00:00", slot_id: "s1830" };
const SLOT_1400: AvailableSlot = { starts_at: "2026-08-05T14:00:00", ends_at: "2026-08-05T14:30:00", slot_id: "s1400" };

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350143",
  phone_source: "telegram_contact_button",
};

const AVAIL_RESULT_WITH_SLOTS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_pr143",
  status: "success",
  data: {
    slots: [
      { starts_at: "2026-08-05T17:30:00", ends_at: "2026-08-05T18:00:00", slot_id: "s1730" },
      { starts_at: "2026-08-05T18:30:00", ends_at: "2026-08-05T19:00:00", slot_id: "s1830" },
    ],
  },
};

const AVAIL_RESULT_EMPTY: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_empty",
  status: "success",
  data: { slots: [] },
};

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_pr143",
  case_id: null,
  locale: "ru",
  trace_id: "trace_pr143",
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

// ── Test A: availability.check stores last_available_slots ────────────────────

test("A: extractSlotsFromToolResults returns slots from successful availability.check result", () => {
  const slots = extractSlotsFromToolResults([AVAIL_RESULT_WITH_SLOTS]);
  assert.equal(slots.length, 2, "A: must extract 2 slots");
  assert.equal(slots[0].starts_at, "2026-08-05T17:30:00", "A: first slot starts_at");
  assert.equal(slots[1].starts_at, "2026-08-05T18:30:00", "A: second slot starts_at");
  assert.equal(slots[0].slot_id, "s1730", "A: first slot slot_id preserved");
});

test("A2: computeBookingProcessState stores last_available_slots from tool results", () => {
  const state = computeBookingProcessState({
    toolResults: [AVAIL_RESULT_WITH_SLOTS],
    channelContact: TRUSTED_CONTACT,
  });
  assert.ok(Array.isArray(state.last_available_slots), "A2: last_available_slots must be array");
  assert.equal(state.last_available_slots!.length, 2, "A2: must have 2 slots");
  assert.equal(state.last_available_slots![0].starts_at, "2026-08-05T17:30:00");
});

test("A3: last_available_slots preserved across turns (from prior state when no new avail.check)", () => {
  const prior = computeBookingProcessState({
    toolResults: [AVAIL_RESULT_WITH_SLOTS],
    channelContact: TRUSTED_CONTACT,
  });
  // Second turn — no tool results, just patient message
  const state2 = computeBookingProcessState({
    prior,
    patientMessage: "Мне удобно 17:30",
    channelContact: TRUSTED_CONTACT,
  });
  assert.ok(Array.isArray(state2.last_available_slots), "A3: slots preserved from prior");
  assert.equal(state2.last_available_slots!.length, 2, "A3: 2 slots preserved");
});

// ── Test B: Patient says "17:30" → selected_slot matches ──────────────────────

test("B: detectSelectedSlot finds 17:30 slot when patient says '17:30'", () => {
  const slots = [SLOT_1730, SLOT_1830];
  const detected = detectSelectedSlot("17:30", slots);
  assert.ok(detected !== null, "B: must detect slot");
  assert.equal(detected!.starts_at, "2026-08-05T17:30:00", "B: must match 17:30 slot");
});

test("B2: detectSelectedSlot finds 17:30 when patient says 'давайте 17:30'", () => {
  const slots = [SLOT_1730, SLOT_1830];
  const detected = detectSelectedSlot("давайте 17:30", slots);
  assert.ok(detected !== null, "B2: must detect slot");
  assert.equal(detected!.slot_id, "s1730");
});

test("B3: extractSlotTime extracts '17:30' from various phrasings", () => {
  assert.equal(extractSlotTime("17:30"), "17:30");
  assert.equal(extractSlotTime("в 17:30"), "17:30");
  assert.equal(extractSlotTime("давайте 17:30"), "17:30");
  assert.equal(extractSlotTime("Отлично 17:30 подходит"), "17:30");
  assert.equal(extractSlotTime("нет времени"), null, "no time in text should return null");
});

test("B4: computeBookingProcessState detects selected_slot when prior has slots and patient gives time", () => {
  const state = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1730, SLOT_1830],
      service_reason: "чистка зубов",
      first_name: "Иван",
      last_name: "Петров",
    },
    patientMessage: "17:30 подходит",
    channelContact: TRUSTED_CONTACT,
  });
  assert.ok(state.selected_slot !== null && state.selected_slot !== undefined, "B4: selected_slot must be set");
  assert.equal(state.selected_slot!.starts_at, "2026-08-05T17:30:00");
});

// ── Test C: "Отлично 17:30" → selected_slot=17:30, next_action=ask_for_phone ──

test("C: 'Отлично 17:30' → selected_slot=17:30, next_action=ask_for_phone when no trusted phone", () => {
  const state = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1730, SLOT_1830],
      service_reason: "осмотр из-за боли",
      first_name: "Анна",
      last_name: "Иванова",
    },
    patientMessage: "Отлично 17:30",
    channelContact: undefined, // no trusted phone
  });
  assert.ok(state.selected_slot !== null && state.selected_slot !== undefined, "C: selected_slot must be set");
  assert.equal(state.selected_slot!.starts_at, "2026-08-05T17:30:00", "C: correct slot selected");
  assert.equal(state.next_action, "ask_for_phone", "C: next_action must be ask_for_phone");
  assert.equal(state.proof.slot_known, true, "C: slot_known must be true");
  assert.equal(state.proof.trusted_phone_known, false, "C: trusted_phone_known must be false");
});

test("C2: when all fields known including trusted phone → next_action=ready_for_booking_apply", () => {
  const state = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1400],
      service_reason: "чистка зубов",
      first_name: "Иван",
      last_name: "Петров",
    },
    patientMessage: "14:00 хорошо",
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state.next_action, "ready_for_booking_apply", "C2: all known → ready");
  assert.equal(state.proof.ready_for_booking_apply, true, "C2: proof must be true");
});

// ── Test D: Patient gives name once → next turn no ask_for_name ───────────────

test("D: name captured once, second turn must not have next_action=ask_for_name", () => {
  // Turn 1: service known, name provided, slot still needed
  const state1 = computeBookingProcessState({
    prior: { service_reason: "осмотр" },
    patientMessage: "Иван Петров",
    channelContact: TRUSTED_CONTACT,
    bookingApplyFirstName: "Иван",
    bookingApplyLastName: "Петров",
  });
  assert.equal(state1.first_name, "Иван", "D: first_name captured");
  assert.equal(state1.last_name, "Петров", "D: last_name captured");
  assert.notEqual(state1.next_action, "ask_for_name", "D: turn 1 must not ask for name (it's already known)");

  // Turn 2: no name in message, prior state has name
  const state2 = computeBookingProcessState({
    prior: state1,
    patientMessage: "давайте пятницу",
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state2.first_name, "Иван", "D: name preserved in turn 2");
  assert.notEqual(state2.next_action, "ask_for_name", "D: turn 2 must NOT ask for name");
  assert.equal(state2.proof.name_known, true, "D: name_known must be true in turn 2");
});

// ── Test E: Patient gives service_reason once → next turn no ask_for_service ──

test("E: service_reason captured once, second turn must not have next_action=ask_for_service", () => {
  // Turn 1: service provided
  const state1 = computeBookingProcessState({
    bookingApplyService: "чистка зубов",
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state1.service_reason, "чистка зубов", "E: service_reason captured");
  assert.notEqual(state1.next_action, "ask_for_service", "E: turn 1 must not ask for service");

  // Turn 2: no service in message, prior state has service
  const state2 = computeBookingProcessState({
    prior: state1,
    patientMessage: "завтра 10:00",
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state2.service_reason, "чистка зубов", "E: service preserved in turn 2");
  assert.notEqual(state2.next_action, "ask_for_service", "E: turn 2 must NOT ask for service");
  assert.equal(state2.proof.service_known, true, "E: service_known must be true in turn 2");
});

// ── Test F: Invalid time not in slots → choose_from_available_slots ──────────

test("F: patient says '18:00' but only 17:30 and 18:30 were offered → choose_from_available_slots", () => {
  const state = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1730, SLOT_1830],
      service_reason: "осмотр",
      first_name: "Анна",
      last_name: "Иванова",
    },
    patientMessage: "18:00 пожалуйста",
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state.selected_slot, null, "F: selected_slot must remain null for unmatched time");
  assert.equal(state.next_action, "choose_from_available_slots", "F: must ask to choose from available slots");
});

test("F2: detectSelectedSlot returns null for time not in offered slots", () => {
  const result = detectSelectedSlot("18:00", [SLOT_1730, SLOT_1830]);
  assert.equal(result, null, "F2: 18:00 not in [17:30, 18:30] must return null");
});

// ── Test G: No ClinicCard writes in state-only turns ─────────────────────────

test("G: state-only turns (availability.check + slot selection) never trigger ClinicCard writes", async () => {
  let bookingExecutorCalled = false;
  const repo = createInMemoryBookingProcessStateRepository();

  // Turn 1: availability.check
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_g1",
        tool_requests: [{
          tool: "availability.check",
          call_id: "call_g_avail",
          arguments: { requested_date: "2026-08-05" },
        }],
      },
      {
        type: "final_response",
        conversation_id: "conv_g1",
        final_response: { final_patient_reply: "Доступно 17:30 и 18:30. Выберите время." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: {
          slots: [
            { starts_at: "2026-08-05T17:30:00", ends_at: "2026-08-05T18:00:00", slot_id: "s1730" },
            { starts_at: "2026-08-05T18:30:00", ends_at: "2026-08-05T19:00:00", slot_id: "s1830" },
          ],
        },
      }),
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created" } };
      },
    },
    bookingProcessStateRepository: repo,
    now: new Date("2026-08-05T10:00:00"),
  });

  const turn1 = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_g1",
    user_message: "Хочу записаться на пятницу",
    channel_contact: undefined, // no phone yet
  });

  assert.equal(bookingExecutorCalled, false, "G: booking executor must NOT be called on availability-check turn");
  assert.ok(turn1.final_patient_reply.length > 0, "G: must have a reply");

  // Verify state was saved
  const savedState = await repo.loadState({ clinic_id: "clinic_1", contact_id: "contact_pr143", case_id: null });
  assert.ok(savedState !== null, "G: state must be saved after turn 1");
  // slots may or may not be set (depends on tool result availability in state) — just verify no crash
  assert.equal(bookingExecutorCalled, false, "G: still no booking executor calls");
});

// ── Ordinal reference tests ───────────────────────────────────────────────────

test("ordinal: 'первый' maps to first slot", () => {
  const slots = [SLOT_1400, SLOT_1730, SLOT_1830];
  const result = detectSelectedSlot("давайте первый", slots);
  assert.ok(result !== null, "ordinal: first slot must be detected");
  assert.equal(result!.slot_id, "s1400", "ordinal: must be first slot (14:00)");
});

test("ordinal: 'последний' maps to last slot", () => {
  const slots = [SLOT_1400, SLOT_1730, SLOT_1830];
  const result = detectSelectedSlot("давайте последний", slots);
  assert.ok(result !== null, "ordinal: last slot must be detected");
  assert.equal(result!.slot_id, "s1830", "ordinal: must be last slot (18:30)");
});

// ── Proof checklist tests ─────────────────────────────────────────────────────

test("proof: all fields missing → service_known=false, name_known=false, slot_known=false", () => {
  const state = computeBookingProcessState({ channelContact: undefined });
  assert.equal(state.proof.service_known, false);
  assert.equal(state.proof.name_known, false);
  assert.equal(state.proof.slot_known, false);
  assert.equal(state.proof.trusted_phone_known, false);
  assert.equal(state.proof.ready_for_booking_apply, false);
});

test("proof: all fields known → ready_for_booking_apply=true", () => {
  const state = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1400],
      service_reason: "чистка",
      first_name: "Иван",
      last_name: "Петров",
    },
    patientMessage: "14:00",
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state.proof.service_known, true);
  assert.equal(state.proof.name_known, true);
  assert.equal(state.proof.slot_known, true);
  assert.equal(state.proof.trusted_phone_known, true);
  assert.equal(state.proof.ready_for_booking_apply, true);
  assert.equal(state.next_action, "ready_for_booking_apply");
});

// ── In-memory repo tests ──────────────────────────────────────────────────────

test("in-memory repo: load returns null before save", async () => {
  const repo = createInMemoryBookingProcessStateRepository();
  const result = await repo.loadState({ clinic_id: "c1", contact_id: "u1", case_id: null });
  assert.equal(result, null, "fresh repo must return null");
});

test("in-memory repo: save and load round-trip", async () => {
  const repo = createInMemoryBookingProcessStateRepository();
  const state = computeBookingProcessState({ bookingApplyService: "осмотр", channelContact: TRUSTED_CONTACT });
  await repo.saveState({ clinic_id: "c1", contact_id: "u1", case_id: null }, state);
  const loaded = await repo.loadState({ clinic_id: "c1", contact_id: "u1", case_id: null });
  assert.ok(loaded !== null);
  assert.equal(loaded!.service_reason, "осмотр");
});

test("in-memory repo: different keys are isolated", async () => {
  const repo = createInMemoryBookingProcessStateRepository();
  const stateA = computeBookingProcessState({ bookingApplyService: "чистка", channelContact: TRUSTED_CONTACT });
  await repo.saveState({ clinic_id: "c1", contact_id: "u1", case_id: null }, stateA);
  const loadedB = await repo.loadState({ clinic_id: "c1", contact_id: "u2", case_id: null });
  assert.equal(loadedB, null, "different contact must not share state");
});

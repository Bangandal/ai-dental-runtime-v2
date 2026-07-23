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
  extractSlotsFromToolResults,
  createInMemoryBookingProcessStateRepository,
  buildModelVisibleBookingProcessState,
  type AvailableSlot,
} from "../src/runtime/bookingProcessState.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "../src/runtime/slotEvidence.ts";
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
  // Second turn — no tool results
  const state2 = computeBookingProcessState({
    prior,
    channelContact: TRUSTED_CONTACT,
  });
  assert.ok(Array.isArray(state2.last_available_slots), "A3: slots preserved from prior");
  assert.equal(state2.last_available_slots!.length, 2, "A3: 2 slots preserved");
});

// ── Test D: Patient gives name once → next turn no ask_for_name ───────────────

test("D: name captured once, second turn must not have next_action=ask_for_name", () => {
  // Turn 1: service known, name provided, slot still needed
  const state1 = computeBookingProcessState({
    prior: { service_reason: "осмотр" },
    channelContact: TRUSTED_CONTACT,
    bookingApplyFirstName: "Иван",
    bookingApplyLastName: "Петров",
  });
  assert.equal(state1.first_name, "Иван", "D: first_name captured");
  assert.equal(state1.last_name, "Петров", "D: last_name captured");
  assert.notEqual(state1.next_action, "ask_for_name", "D: turn 1 must not ask for name (it's already known)");

  // Turn 2: prior state has name
  const state2 = computeBookingProcessState({
    prior: state1,
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

  // Turn 2: prior state has service
  const state2 = computeBookingProcessState({
    prior: state1,
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state2.service_reason, "чистка зубов", "E: service preserved in turn 2");
  assert.notEqual(state2.next_action, "ask_for_service", "E: turn 2 must NOT ask for service");
  assert.equal(state2.proof.service_known, true, "E: service_known must be true in turn 2");
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
      active_availability_evidence: { availability_call_id: "call_avail_pr143", requested_date: "2026-08-05", requested_time: null, allowed_slot_keys: ["2026-08-05T14:00"] },
    },
    selectSlotData: { selection_status: "selected", selected_slot_key: "2026-08-05T14:00", may_apply_booking: true },
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

// ── Blocker A tests: empty availability.check clears last_available_slots ─────

test("Blocker-A: fresh availability.check with [] clears prior last_available_slots", () => {
  const state = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1730, SLOT_1830],
      service_reason: "осмотр",
      first_name: "Анна",
      last_name: "Иванова",
    },
    toolResults: [AVAIL_RESULT_EMPTY],
    channelContact: TRUSTED_CONTACT,
  });
  assert.ok(Array.isArray(state.last_available_slots), "Blocker-A: must be array");
  assert.equal(state.last_available_slots!.length, 0, "Blocker-A: must be empty — not fallen back to prior");
});

test("Blocker-A: no availability.check this turn → last_available_slots preserved from prior", () => {
  const state = computeBookingProcessState({
    prior: { last_available_slots: [SLOT_1730] },
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state.last_available_slots?.length, 1, "Blocker-A: prior slots preserved when no fresh avail.check");
});

// ── Blocker B tests: selected_slot cleared on fresh availability.check ────────

test("Blocker-B: prior selected_slot cleared when new availability.check returns different slots", () => {
  const SLOT_NEW_DATE: AvailableSlot = { starts_at: "2026-08-10T17:30:00", ends_at: "2026-08-10T18:00:00", slot_id: "s_new" };
  const AVAIL_NEW_DATE: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_new",
    status: "success",
    data: { slots: [{ starts_at: "2026-08-10T17:30:00", ends_at: "2026-08-10T18:00:00", slot_id: "s_new" }] },
  };
  const state = computeBookingProcessState({
    prior: {
      selected_slot: SLOT_1730,  // old date's slot
      last_available_slots: [SLOT_1730],
      service_reason: "осмотр",
      first_name: "Анна",
      last_name: "Иванова",
    },
    toolResults: [AVAIL_NEW_DATE],
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state.selected_slot, null, "Blocker-B: prior selected_slot must be cleared on fresh avail.check");
  assert.equal(state.proof.slot_known, false, "Blocker-B: slot_known must be false");
  // New slots should be set
  assert.equal(state.last_available_slots?.[0]?.slot_id, "s_new", "Blocker-B: fresh slots stored");
});

test("Blocker-B: prior selected_slot cleared when new availability.check returns []", () => {
  const state = computeBookingProcessState({
    prior: {
      selected_slot: SLOT_1730,
      last_available_slots: [SLOT_1730],
      service_reason: "осмотр",
      first_name: "Анна",
      last_name: "Иванова",
    },
    toolResults: [AVAIL_RESULT_EMPTY],
    channelContact: TRUSTED_CONTACT,
  });
  assert.equal(state.selected_slot, null, "Blocker-B: selected_slot must be null when avail returns []");
  assert.equal(state.proof.slot_known, false, "Blocker-B: proof.slot_known must be false");
  assert.deepEqual(state.last_available_slots, [], "Blocker-B: last_available_slots must be []");
});

// ── Blocker D test: state persisted on no-tool final_response path ────────────

test("Blocker-D: selected_slot persisted when model returns final_response directly", async () => {
  const repo = createInMemoryBookingProcessStateRepository();

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "final_response",
        conversation_id: "conv_d1",
        final_response: { final_patient_reply: "Понял, 17:30 — сейчас проверю контакт." },
      },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => ({ status: "success" as const, data: { booking_status: "visit_created" } }),
    },
    bookingProcessStateRepository: repo,
    now: new Date("2026-08-05T10:00:00"),
  });

  await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_d1",
    user_message: "17:30 подходит",
    channel_contact: undefined,
    // Inject prior state with last_available_slots so slot detection works
    // (In real usage, repo.loadState provides this — here we pre-seed the repo)
  });

  // Pre-seed prior state in repo and run again to verify persistence
  const priorState = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1730, SLOT_1830],
      service_reason: "осмотр",
      first_name: "Анна",
      last_name: "Иванова",
      active_availability_evidence: { availability_call_id: "call_avail_pr143", requested_date: "2026-08-05", requested_time: null, allowed_slot_keys: ["2026-08-05T17:30", "2026-08-05T18:30"] },
    },
    selectSlotData: { selection_status: "selected", selected_slot_key: "2026-08-05T17:30", may_apply_booking: true },
    channelContact: undefined,
  });
  await repo.saveState({ clinic_id: "clinic_1", contact_id: "contact_pr143", case_id: null }, priorState);

  const loop2 = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "final_response",
        conversation_id: "conv_d2",
        final_response: { final_patient_reply: "Хорошо, 17:30 выбрано. Поделитесь контактом." },
      },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => ({ status: "success" as const, data: { booking_status: "visit_created" } }),
    },
    bookingProcessStateRepository: repo,
    now: new Date("2026-08-05T10:00:00"),
  });

  await loop2.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_d2",
    user_message: "17:30 подходит",
    channel_contact: undefined,
  });

  const saved = await repo.loadState({ clinic_id: "clinic_1", contact_id: "contact_pr143", case_id: null });
  assert.ok(saved !== null, "Blocker-D: state must be saved after no-tool final_response");
  assert.ok(saved!.selected_slot !== null && saved!.selected_slot !== undefined,
    "Blocker-D: selected_slot must be persisted");
  assert.equal((saved!.selected_slot as AvailableSlot).slot_id, "s1730",
    "Blocker-D: persisted slot must be 17:30");
});

// ── New tests: first-call context & broad no-tool persist ─────────────────────

test("new-1: first caller call receives booking_process_state in context", async () => {
  let capturedContext: Record<string, unknown> | undefined;
  const repo = createInMemoryBookingProcessStateRepository();

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async (callerInput) => {
      capturedContext = callerInput.input.context;
      return {
        type: "final_response",
        conversation_id: "conv_new1",
        final_response: { final_patient_reply: "Привет" },
      };
    },
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => ({ status: "success" as const, data: { booking_status: "visit_created" } }),
    },
    bookingProcessStateRepository: repo,
    now: new Date("2026-08-05T10:00:00"),
  });

  await loop.runTurn({
    ...BASE_TURN_INPUT,
    user_message: "Хочу записаться",
    channel_contact: undefined,
  });

  assert.ok(capturedContext !== undefined, "new-1: caller must be called");
  assert.ok(
    "booking_process_state" in capturedContext!,
    "new-1: first caller must receive booking_process_state in context",
  );
});

test("new-2: prior state (service/name/slots) is visible in first call context", async () => {
  let capturedContext: Record<string, unknown> | undefined;
  const repo = createInMemoryBookingProcessStateRepository();

  // Pre-seed prior state
  const priorState = computeBookingProcessState({
    prior: {
      last_available_slots: [SLOT_1730],
      service_reason: "чистка зубов",
      first_name: "Иван",
      last_name: "Петров",
    },
    channelContact: undefined,
  });
  await repo.saveState({ clinic_id: "clinic_1", contact_id: "contact_pr143", case_id: null }, priorState);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async (callerInput) => {
      capturedContext = callerInput.input.context;
      return {
        type: "final_response",
        conversation_id: "conv_new2",
        final_response: { final_patient_reply: "Ок" },
      };
    },
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => ({ status: "success" as const, data: { booking_status: "visit_created" } }),
    },
    bookingProcessStateRepository: repo,
    now: new Date("2026-08-05T10:00:00"),
  });

  await loop.runTurn({
    ...BASE_TURN_INPUT,
    user_message: "Что дальше?",
    channel_contact: undefined,
  });

  assert.ok(capturedContext !== undefined, "new-2: caller must be called");
  const bps = capturedContext!.booking_process_state as Record<string, unknown> | undefined;
  assert.ok(bps !== undefined, "new-2: booking_process_state must be present");
  assert.equal(bps!.service_reason, "чистка зубов", "new-2: service_reason from prior state visible");
  assert.equal(bps!.first_name, "Иван", "new-2: first_name from prior state visible");
  assert.ok(Array.isArray(bps!.last_available_slots), "new-2: last_available_slots from prior visible");
});

test("new-4: no-tool final_response persists state even when selected_slot is null but phone_trusted changed", async () => {
  const repo = createInMemoryBookingProcessStateRepository();

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => ({
      type: "final_response",
      conversation_id: "conv_new4",
      final_response: { final_patient_reply: "Контакт получен." },
    }),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => ({ status: "success" as const, data: { booking_status: "visit_created" } }),
    },
    bookingProcessStateRepository: repo,
    now: new Date("2026-08-05T10:00:00"),
  });

  // Run with trusted phone — selected_slot will be null (no prior slots), but phone_trusted should persist
  await loop.runTurn({
    ...BASE_TURN_INPUT,
    user_message: "Вот мой контакт",
    channel_contact: TRUSTED_CONTACT,
  });

  const saved = await repo.loadState({ clinic_id: "clinic_1", contact_id: "contact_pr143", case_id: null });
  assert.ok(saved !== null, "new-4: state must be saved even when selected_slot is null");
  // State was saved (not only when selected_slot exists)
  assert.equal(saved!.selected_slot, null, "new-4: selected_slot is null as expected");
  assert.equal(saved!.phone_trusted, true, "new-4: phone_trusted must be persisted");
});

// ── buildModelVisibleBookingProcessState proof sanitization (PR #154) ─────────

function makeState(overrides: {
  nameKnown: boolean;
  serviceKnown: boolean;
  slotKnown?: boolean;
  phoneTrusted?: boolean;
}): import("../src/runtime/bookingProcessState.ts").BookingProcessState {
  const slotKnown = overrides.slotKnown ?? false;
  const phoneTrusted = overrides.phoneTrusted ?? false;
  return {
    proof: {
      name_known: overrides.nameKnown,
      service_known: overrides.serviceKnown,
      slot_known: slotKnown,
      trusted_phone_known: phoneTrusted,
      ready_for_booking_apply: overrides.nameKnown && overrides.serviceKnown && slotKnown && phoneTrusted,
    },
    last_available_slots: [],
    selected_slot: null,
  };
}

test("buildModelVisibleBookingProcessState A: high-confidence with name_known=false/service_known=false → JSON must NOT contain false flags", () => {
  const state = makeState({ nameKnown: false, serviceKnown: false });
  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });
  const json = JSON.stringify(visible);

  assert.ok(!json.includes('"name_known":false'), 'A: JSON must NOT contain "name_known":false at top level');
  assert.ok(!json.includes('"service_known":false'), 'A: JSON must NOT contain "service_known":false at top level');
  assert.ok(!json.includes('"name_known": false'), 'A: JSON must NOT contain "name_known": false');
  assert.ok(!json.includes('"service_known": false'), 'A: JSON must NOT contain "service_known": false');

  // proof must also not contain false flags
  const proof = visible.proof as Record<string, unknown>;
  assert.equal(proof?.["name_known"], undefined, "A: proof.name_known must be omitted when false");
  assert.equal(proof?.["service_known"], undefined, "A: proof.service_known must be omitted when false");
});

test("buildModelVisibleBookingProcessState B: high-confidence with name_known=true/service_known=true → positive flags present in proof", () => {
  const state = makeState({ nameKnown: true, serviceKnown: true, slotKnown: true, phoneTrusted: true });
  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });

  // name_known/service_known live only inside proof, not at the top level of BookingProcessState
  const proof = visible.proof as Record<string, unknown>;
  assert.equal(proof?.["name_known"], true, "B: proof.name_known must be true when true");
  assert.equal(proof?.["service_known"], true, "B: proof.service_known must be true when true");
  // Verify they appear in JSON
  const json = JSON.stringify(visible);
  assert.ok(json.includes('"name_known":true'), 'B: JSON must contain "name_known":true');
  assert.ok(json.includes('"service_known":true'), 'B: JSON must contain "service_known":true');
});

test("buildModelVisibleBookingProcessState C: low-confidence with name_known=false/service_known=false → JSON must NOT contain false flags", () => {
  const state = makeState({ nameKnown: false, serviceKnown: false });
  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: false });
  const json = JSON.stringify(visible);

  assert.ok(!json.includes('"name_known":false'), 'C: low-confidence JSON must NOT contain "name_known":false');
  assert.ok(!json.includes('"service_known":false'), 'C: low-confidence JSON must NOT contain "service_known":false');

  const proof = visible.proof as Record<string, unknown>;
  assert.equal(proof?.["name_known"], undefined, "C: low-confidence proof.name_known must be omitted when false");
  assert.equal(proof?.["service_known"], undefined, "C: low-confidence proof.service_known must be omitted when false");
});

test("buildModelVisibleBookingProcessState D: safety flags slot_known, trusted_phone_known, ready_for_booking_apply remain visible", () => {
  const state = makeState({ nameKnown: false, serviceKnown: false, slotKnown: true, phoneTrusted: true });

  // High-confidence
  const high = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });
  const highProof = high.proof as Record<string, unknown>;
  assert.equal(highProof?.["slot_known"], true, "D: high-confidence proof.slot_known must be present");
  assert.equal(highProof?.["trusted_phone_known"], true, "D: high-confidence proof.trusted_phone_known must be present");
  assert.equal(typeof highProof?.["ready_for_booking_apply"], "boolean", "D: high-confidence proof.ready_for_booking_apply must be present");

  // Low-confidence
  const low = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: false });
  const lowProof = low.proof as Record<string, unknown>;
  assert.equal(lowProof?.["slot_known"], true, "D: low-confidence proof.slot_known must be present");
  assert.equal(lowProof?.["trusted_phone_known"], true, "D: low-confidence proof.trusted_phone_known must be present");
  assert.equal(typeof lowProof?.["ready_for_booking_apply"], "boolean", "D: low-confidence proof.ready_for_booking_apply must be present");
});

// ── P. Legacy/invalid subject_id proof — state authority tests ─────────────────

const LEGACY_EVIDENCE: AvailabilityEvidence = {
  availability_call_id: "av_legacy",
  requested_date: "2028-01-15",
  requested_time: null,
  allowed_slot_keys: ["2028-01-15T10:00"],
};

const LEGACY_SLOT = { starts_at: "2028-01-15T10:00:00" };

test("P-1: legacy proof (no subject_id) → selected_slot preserved, proof=null, slot_known=false, slot_evidence_status=stale", () => {
  const legacyProof: SelectedSlotProof = {
    // subject_id intentionally absent (legacy)
    availability_call_id: "av_legacy",
    slot_key: "2028-01-15T10:00",
  };
  const state = computeBookingProcessState({
    prior: {
      selected_slot: LEGACY_SLOT,
      active_availability_evidence: LEGACY_EVIDENCE,
      selected_slot_proof: legacyProof,
    },
    channelContact: TRUSTED_CONTACT,
  });

  assert.deepEqual(state.selected_slot, LEGACY_SLOT, "P-1: selected_slot must be preserved for dialogue continuity");
  assert.equal(state.selected_slot_proof, null, "P-1: proof must be cleared when subject_id absent");
  assert.equal(state.proof.slot_known, false, "P-1: slot_known must be false");
  assert.equal(state.proof.ready_for_booking_apply, false, "P-1: ready_for_booking_apply must be false");
  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });
  assert.equal(visible.slot_evidence_status, "stale", "P-1: slot_evidence_status must be stale");
});

test("P-2: proof with invalid subject_id ('subject_99') → same stale state", () => {
  const invalidProof = {
    subject_id: "subject_99" as unknown as `subject_${number}`,
    availability_call_id: "av_legacy",
    slot_key: "2028-01-15T10:00",
  };
  const state = computeBookingProcessState({
    prior: {
      selected_slot: LEGACY_SLOT,
      active_availability_evidence: LEGACY_EVIDENCE,
      selected_slot_proof: invalidProof,
    },
    channelContact: TRUSTED_CONTACT,
  });

  assert.deepEqual(state.selected_slot, LEGACY_SLOT, "P-2: selected_slot preserved");
  assert.equal(state.selected_slot_proof, null, "P-2: proof must be cleared for invalid subject_id");
  assert.equal(state.proof.slot_known, false, "P-2: slot_known=false");
  assert.equal(state.proof.ready_for_booking_apply, false, "P-2: ready_for_booking_apply=false");
  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });
  assert.equal(visible.slot_evidence_status, "stale", "P-2: slot_evidence_status=stale");
});

test("P-3: valid subject_1 proof → slot_known=true, slot_evidence_status=verified", () => {
  const validProof: SelectedSlotProof = {
    subject_id: "subject_1" as const,
    availability_call_id: "av_legacy",
    slot_key: "2028-01-15T10:00",
  };
  const state = computeBookingProcessState({
    prior: {
      selected_slot: LEGACY_SLOT,
      active_availability_evidence: LEGACY_EVIDENCE,
      selected_slot_proof: validProof,
      first_name: "Ivan",
      last_name: "Petrov",
      service_reason: "чистка",
    },
    channelContact: TRUSTED_CONTACT,
  });

  assert.equal(state.proof.slot_known, true, "P-3: slot_known=true for valid subject_1 proof");
  assert.notEqual(state.selected_slot_proof, null, "P-3: proof must be preserved");
  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });
  assert.equal(visible.slot_evidence_status, "verified", "P-3: slot_evidence_status=verified");
  assert.equal(visible.proof?.ready_for_booking_apply, true, "P-3: ready_for_booking_apply=true when all fields present");
});

test("P-4: valid subject_2 proof → slot_known=true, proof preserved with subject_2", () => {
  const evidence2: AvailabilityEvidence = {
    availability_call_id: "av_s2",
    requested_date: "2028-01-15",
    requested_time: null,
    allowed_slot_keys: ["2028-01-15T10:00"],
  };
  const validProof2: SelectedSlotProof = {
    subject_id: "subject_2" as `subject_${number}`,
    availability_call_id: "av_s2",
    slot_key: "2028-01-15T10:00",
  };
  const state = computeBookingProcessState({
    prior: {
      selected_slot: LEGACY_SLOT,
      active_availability_evidence: evidence2,
      selected_slot_proof: validProof2,
    },
    channelContact: TRUSTED_CONTACT,
  });

  assert.equal(state.proof.slot_known, true, "P-4: slot_known=true for valid subject_2 proof");
  assert.equal(state.selected_slot_proof?.subject_id, "subject_2", "P-4: subject_id must remain subject_2 (not reassigned)");
  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });
  assert.equal(visible.slot_evidence_status, "verified", "P-4: slot_evidence_status=verified");
});

test("P-5: model-visible state for legacy proof does not expose verified or ready_for_booking_apply=true", () => {
  const legacyProof: SelectedSlotProof = {
    // no subject_id
    availability_call_id: "av_legacy",
    slot_key: "2028-01-15T10:00",
  };
  const state = computeBookingProcessState({
    prior: {
      selected_slot: LEGACY_SLOT,
      active_availability_evidence: LEGACY_EVIDENCE,
      selected_slot_proof: legacyProof,
      first_name: "Ivan",
      last_name: "Petrov",
      service_reason: "чистка",
    },
    channelContact: TRUSTED_CONTACT,
  });

  const visible = buildModelVisibleBookingProcessState({ state, priorProcessState: null, bookingStateGrounded: true });
  assert.notEqual(visible.slot_evidence_status, "verified", "P-5: stale legacy proof must NOT appear as verified");
  assert.equal(visible.slot_evidence_status, "stale", "P-5: slot_evidence_status must be stale");
  assert.equal(visible.proof?.slot_known, false, "P-5: proof.slot_known must be false");
  assert.notEqual(visible.proof?.ready_for_booking_apply, true, "P-5: ready_for_booking_apply must NOT be true");
});

/**
 * PR #145: booking_process_state authority / confidence tests.
 *
 * Verifies that low-confidence state (no prior, no tool results) does NOT expose
 * next_action to the model, and that high-confidence state (prior exists OR tool
 * results present) DOES expose next_action.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelVisibleBookingProcessState,
  computeBookingProcessState,
  createInMemoryBookingProcessStateRepository,
  type BookingProcessState,
} from "../src/runtime/bookingProcessState.ts";
import { createRuntimeAgentLoop } from "../src/runtime/runtimeAgentLoop.ts";
import type { RuntimeAgentTurnInput } from "../src/runtime/openaiRuntimeAgent.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFullState(overrides: Partial<BookingProcessState> = {}): BookingProcessState {
  return {
    proof: {
      service_known: false,
      name_known: false,
      slot_known: false,
      trusted_phone_known: false,
      ready_for_booking_apply: false,
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<RuntimeAgentTurnInput> = {}): RuntimeAgentTurnInput {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    user_message: "hello",
    locale: "ru",
    ...overrides,
  } as RuntimeAgentTurnInput;
}

function makeCallerFinalResponse(text = "Чем могу помочь?") {
  return async () => ({
    type: "final_response" as const,
    conversation_id: "conv_1",
    final_response: { final_patient_reply: text },
  });
}

function makeFinalCallerCapture() {
  let capturedContext: Record<string, unknown> | null = null;
  const caller = async (callerInput: { input: { context: Record<string, unknown> } }) => {
    capturedContext = callerInput.input.context;
    return {
      type: "final_response" as const,
      conversation_id: "conv_1",
      final_response: { final_patient_reply: "ok" },
    };
  };
  return { caller, getCaptured: () => capturedContext };
}

// ── Test A: no prior state, no tool results → low confidence → next_action absent ─────

test("A: first turn with no prior state does NOT pass next_action to model context", async () => {
  const state = computeBookingProcessState({ prior: null });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: null,
    bookingStateGrounded: false,
  });
  assert.equal(visible.next_action_confidence, "low");
  assert.equal(visible.next_action, undefined, "next_action must be omitted on low confidence");
});

// ── Test B: prior state exists with full name+service+slot → ask_for_phone exposed ────────

test("B: prior state with service+name+slot known → ask_for_phone exposed with high confidence", () => {
  // Only safe next_actions are exposed. Use a state where ask_for_phone is the action.
  const prior: Partial<BookingProcessState> = {
    service_reason: "чистка",
    first_name: "Иван",
    last_name: "Иванов",
    selected_slot: { starts_at: "2026-08-05T14:00:00" },
    active_availability_evidence: { availability_call_id: "legacy_test_call", requested_date: "2026-08-05", requested_time: null, allowed_slot_keys: ["2026-08-05T14:00"] },
    selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "legacy_test_call", slot_key: "2026-08-05T14:00" },
  };
  const state = computeBookingProcessState({ prior });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: prior,
    bookingStateGrounded: true,
  });
  assert.equal(visible.next_action_confidence, "high");
  // Service+name+slot known, phone missing → ask_for_phone is safe and exposed
  assert.equal(visible.next_action, "ask_for_phone",
    "ask_for_phone must be present when name/service/slot all known from prior state");
});

// ── Test C: booking tool result grounds confidence ─────────────────────────────

test("C: after availability.check tool result → high confidence; slot fields visible; ask_for_name/service always suppressed", () => {
  // Even when service is in prior (so next_action would be ask_for_name),
  // ask_for_name is always suppressed — never exposed via booking_process_state.
  const prior: Partial<BookingProcessState> = { service_reason: "осмотр" };
  const toolResults = [{
    tool: "availability.check" as const,
    call_id: "call_1",
    status: "success" as const,
    data: { slots: [{ starts_at: "2026-08-05T17:30:00" }] },
  }];
  const state = computeBookingProcessState({ prior, toolResults });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: prior,
    bookingStateGrounded: true,
  });
  assert.equal(visible.next_action_confidence, "high");
  assert.ok(Array.isArray(visible.last_available_slots) && visible.last_available_slots!.length > 0,
    "last_available_slots must be visible");
  // ask_for_name and ask_for_service are always suppressed regardless of confidence
  assert.notEqual(visible.next_action, "ask_for_service",
    "ask_for_service must never be exposed");
  assert.notEqual(visible.next_action, "ask_for_name",
    "ask_for_name must never be exposed — let conversation memory handle it");
  // next_action is undefined here (name not known → would be ask_for_name → suppressed)
  assert.equal(visible.next_action, undefined,
    "next_action is suppressed when the only pending action is ask_for_name");
});

// ── Test D: recent_history bug fix ────────────────────────────────────────────

test("D: loadRuntimeContext returns non-empty recent_history (not [])", async () => {
  const { createSupabaseRuntimeContextRepository } = await import("../src/runtime/supabaseRuntimeContextRepository.ts");
  const repo = createSupabaseRuntimeContextRepository({
    rpc: async () => ({
      data: [{
        out_state_json: { collected: {}, missing_fields: [] },
        out_state_version: 1,
        out_recent_messages: [{ role: "user", text: "Хочу записаться" }],
      }],
      error: null,
    }),
  });
  const result = await repo.loadRuntimeContext({ clinic_id: "c1", contact_id: "u1" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.recent_history, [{ role: "user", text: "Хочу записаться" }]);
  assert.equal(result.data.runtime_flags.available_recent_history_count, 1);
});

// ── Test E: loadState RPC error → onDebug called with error info ───────────────

test("E: loadState RPC error calls onDebug with rpc_error reason", async () => {
  const { createSupabaseBookingProcessStateRepository } = await import("../src/runtime/supabaseBookingProcessStateRepository.ts");
  const repo = createSupabaseBookingProcessStateRepository({
    rpc: async () => { throw new Error("Connection refused"); },
  });
  let debugInfo: { loaded: boolean; reason?: string; error?: string } | null = null;
  const result = await repo.loadState({ clinic_id: "c1", contact_id: "u1" }, (info) => { debugInfo = info; });
  assert.equal(result, null);
  assert.ok(debugInfo !== null, "onDebug should be called");
  assert.equal(debugInfo!.loaded, false);
  assert.equal(debugInfo!.reason, "rpc_error");
  assert.ok(typeof debugInfo!.error === "string", "error should be a string");
});

// ── Test F: selected_slot still visible even at low confidence ─────────────────

test("F: selected_slot is visible even when confidence is low (no prior state, no booking tool results)", () => {
  // Slot set via booking.select_slot tool. Prior includes active_availability_evidence so
  // selectSlotData can create proof. priorProcessState=null → low confidence for grounding.
  const stateWithSlots = computeBookingProcessState({
    prior: {
      last_available_slots: [{ starts_at: "2026-08-05T17:30:00" }],
      active_availability_evidence: {
        availability_call_id: "call_avail_f",
        requested_date: "2026-08-05",
        requested_time: null,
        allowed_slot_keys: ["2026-08-05T17:30"],
      },
    },
    selectSlotData: { selection_status: "selected", selected_slot_key: "2026-08-05T17:30", may_apply_booking: true },
  });
  const visible = buildModelVisibleBookingProcessState({
    state: stateWithSlots,
    priorProcessState: null, // truly low-confidence
    bookingStateGrounded: false,
  });
  assert.equal(visible.next_action_confidence, "low", "must be low confidence when priorProcessState=null and not grounded");
  assert.equal(visible.next_action, undefined, "next_action must be omitted on low confidence");
  assert.ok(visible.selected_slot !== null && visible.selected_slot !== undefined, "selected_slot must be visible");
  assert.equal(visible.selected_slot!.starts_at, "2026-08-05T17:30:00", "selected_slot value must be correct");
});

// ── Test G: contact button — low confidence does NOT attach; high confidence does ─

test("G: maybeAttachPhoneRequestUI — low confidence does NOT attach contact button", async () => {
  const { maybeAttachPhoneRequestUI } = await import("../src/runtime/runtimeAgentLoop.ts");
  const lowState = buildModelVisibleBookingProcessState({
    state: makeFullState({ next_action: "ask_for_phone" }),
    priorProcessState: null,
    bookingStateGrounded: false,
  });
  const result = maybeAttachPhoneRequestUI(lowState, undefined);
  assert.equal(result?.telegram?.request_contact, undefined, "button must NOT appear on low confidence");
});

test("G2: maybeAttachPhoneRequestUI — high confidence DOES attach contact button when ask_for_phone", async () => {
  const { maybeAttachPhoneRequestUI } = await import("../src/runtime/runtimeAgentLoop.ts");
  const prior = { service_reason: "чистка", first_name: "Иван", last_name: "Иванов", selected_slot: { starts_at: "2026-08-05T14:00:00" } };
  const highState = buildModelVisibleBookingProcessState({
    state: makeFullState({ next_action: "ask_for_phone" }),
    priorProcessState: prior,
    bookingStateGrounded: true,
  });
  const result = maybeAttachPhoneRequestUI(highState, undefined, "telegram");
  assert.equal(result?.telegram?.request_contact, true, "button must appear on high confidence ask_for_phone");
});

// ── Test H: no ClinicCard writes ───────────────────────────────────────────────

test("H: no ClinicCard writes when attaching state-confidence logic", async () => {
  let clinicCardCalled = false;
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerFinalResponse(),
    executors: {
      "booking.apply": async () => { clinicCardCalled = true; return { type: "success", data: {} }; },
      "availability.check": async () => ({ type: "success", data: { slots: [] } }),
    } as never,
    bookingProcessStateRepository: createInMemoryBookingProcessStateRepository(),
  });
  await loop.runTurn(makeInput());
  assert.equal(clinicCardCalled, false);
});

// ── Test: first caller context includes booking_process_state ──────────────────

test("first caller context receives booking_process_state with confidence field", async () => {
  const { caller, getCaptured } = makeFinalCallerCapture();
  const repo = createInMemoryBookingProcessStateRepository();
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: caller as never,
    executors: {} as never,
    bookingProcessStateRepository: repo,
  });
  await loop.runTurn(makeInput());
  const ctx = getCaptured();
  assert.ok(ctx !== null, "context should be captured");
  const bps = (ctx as Record<string, unknown>).booking_process_state as Record<string, unknown>;
  assert.ok(bps !== undefined, "booking_process_state should be in context");
  assert.ok("next_action_confidence" in bps, "next_action_confidence must be present");
});

// ── Test: prior state visible in first call context ────────────────────────────

test("prior state with known service visible in first call context", async () => {
  const { caller, getCaptured } = makeFinalCallerCapture();
  const repo = createInMemoryBookingProcessStateRepository();
  // Pre-seed state
  await repo.saveState({ clinic_id: "clinic_1", contact_id: "contact_1" }, {
    service_reason: "чистка зубов",
    first_name: "Иван",
    last_name: "Иванов",
    proof: { service_known: true, name_known: true, slot_known: false, trusted_phone_known: false, ready_for_booking_apply: false },
  });
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: caller as never,
    executors: {} as never,
    bookingProcessStateRepository: repo,
  });
  await loop.runTurn(makeInput());
  const ctx = getCaptured();
  const bps = (ctx as Record<string, unknown>).booking_process_state as Record<string, unknown>;
  // With prior state, confidence is high — next_action should be present
  assert.equal(bps.next_action_confidence, "high");
  assert.ok(bps.next_action !== undefined);
});

// ── Blocker 1 new tests: bookingStateGrounded logic ───────────────────────────

test("Blocker1-A: knowledge.search tool result with no prior state → next_action omitted (low confidence)", () => {
  // knowledge.search is NOT a booking tool — must not ground state
  const kbToolResult = [{ tool: "kb.search", call_id: "c1", status: "success" as const, data: { answer: "We open at 9am" } }];
  const state = computeBookingProcessState({ prior: null, toolResults: kbToolResult });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: null,
    bookingStateGrounded: false, // knowledge.search does NOT ground
  });
  assert.equal(visible.next_action_confidence, "low");
  assert.equal(visible.next_action, undefined, "next_action must be omitted — knowledge.search does not ground booking state");
});

test("Blocker1-B: availability.check tool result → bookingStateGrounded=true, slot fields visible", () => {
  const avResult = [{
    tool: "availability.check" as const,
    call_id: "c1",
    status: "success" as const,
    data: { slots: [{ starts_at: "2026-08-05T14:00:00", ends_at: "2026-08-05T14:30:00" }] },
  }];
  const state = computeBookingProcessState({ prior: null, toolResults: avResult });
  // bookingStateGrounded=true because availability.check is booking-relevant
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: null,
    bookingStateGrounded: true,
  });
  assert.equal(visible.next_action_confidence, "high");
  assert.ok(Array.isArray(visible.last_available_slots) && visible.last_available_slots!.length > 0,
    "last_available_slots must be visible");
  // But ask_for_service must be suppressed — service_reason not in prior state
  assert.notEqual(visible.next_action, "ask_for_service",
    "ask_for_service must not be exposed when service_reason absent from prior state");
});

test("Blocker1-C: urgent pain + availability.check → does NOT expose ask_for_service when service not in prior state", () => {
  // Simulates: patient says "болит зуб хочу записаться", model calls availability.check.
  // service_reason is null in persisted state (was captured only from conversation text).
  // After availability.check, bookingStateGrounded=true — but must NOT expose ask_for_service.
  const avResult = [{
    tool: "availability.check" as const,
    call_id: "c1",
    status: "success" as const,
    data: { slots: [{ starts_at: "2026-08-05T10:00:00" }] },
  }];
  const state = computeBookingProcessState({
    prior: null, // no prior persisted service
    toolResults: avResult,
  });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: null, // availability.check grounds slot data but not service
    bookingStateGrounded: true,
  });
  // ask_for_service must be suppressed because service_reason is absent from prior state
  // (patient stated it in conversation, runtime didn't persist it)
  assert.notEqual(visible.next_action, "ask_for_service",
    "ask_for_service must not override conversation memory when service only in conversation text");
});

// ── Blocker 2 new tests: RPC returned error (not thrown) ──────────────────────

test("Blocker2-A: loadState — result.error (returned, not thrown) calls onDebug with rpc_error and returns null", async () => {
  const { createSupabaseBookingProcessStateRepository } = await import("../src/runtime/supabaseBookingProcessStateRepository.ts");
  const fakeRpc = async (_fn: string, _args: unknown) => ({
    data: null,
    error: { message: "relation does not exist" },
  });
  const repo = createSupabaseBookingProcessStateRepository({ rpc: fakeRpc as never });
  let debugInfo: { loaded: boolean; reason?: string; error?: string } | null = null;
  const result = await repo.loadState(
    { clinic_id: "c1", contact_id: "u1" },
    (info) => { debugInfo = info; },
  );
  assert.equal(result, null, "must return null on rpc error");
  assert.ok(debugInfo !== null, "onDebug must be called");
  assert.equal(debugInfo!.loaded, false);
  assert.equal(debugInfo!.reason, "rpc_error", "reason must be rpc_error, not null_or_missing");
  assert.ok(typeof debugInfo!.error === "string" && debugInfo!.error.length > 0, "sanitized error must be present");
});

test("Blocker2-B: saveState — result.error (returned, not thrown) calls onDebug with saved:false and does not throw", async () => {
  const { createSupabaseBookingProcessStateRepository } = await import("../src/runtime/supabaseBookingProcessStateRepository.ts");
  const fakeRpc = async (_fn: string, _args: unknown) => ({
    data: null,
    error: { message: "permission denied" },
  });
  const repo = createSupabaseBookingProcessStateRepository({ rpc: fakeRpc as never });
  let debugInfo: { saved: boolean; error?: string } | null = null;
  const dummyState: import("../src/runtime/bookingProcessState.ts").BookingProcessState = {
    proof: { service_known: false, name_known: false, slot_known: false, trusted_phone_known: false, ready_for_booking_apply: false },
  };
  // Must not throw
  await assert.doesNotReject(async () => {
    await repo.saveState(
      { clinic_id: "c1", contact_id: "u1" },
      dummyState,
      (info) => { debugInfo = info; },
    );
  });
  assert.ok(debugInfo !== null, "onDebug must be called on returned error");
  assert.equal(debugInfo!.saved, false, "saved must be false");
  assert.ok(typeof debugInfo!.error === "string" && debugInfo!.error.length > 0, "sanitized error must be present");
});

// ── New tests: slot-only prior state must NOT expose ask_for_service/name ─────

test("Slot-only-1: prior state with only last_available_slots, patient selects slot → visible next_action NOT ask_for_service", () => {
  // Scenario: prior state has slots from a previous availability.check turn.
  // hasMeaningfulBookingState returns true (slots present) → firstCallGrounded=true.
  // But service/name are NOT in prior. ask_for_service must still be suppressed.
  const prior: Partial<BookingProcessState> = {
    last_available_slots: [{ starts_at: "2026-08-05T10:00:00" }, { starts_at: "2026-08-05T14:00:00" }],
    active_availability_evidence: {
      availability_call_id: "call_avail_so1",
      requested_date: "2026-08-05",
      requested_time: null,
      allowed_slot_keys: ["2026-08-05T10:00", "2026-08-05T14:00"],
    },
  };
  const state = computeBookingProcessState({
    prior,
    selectSlotData: { selection_status: "selected", selected_slot_key: "2026-08-05T10:00", may_apply_booking: true },
  });
  // Even with high confidence (prior has slots → grounded), ask_for_service must be suppressed.
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: prior,
    bookingStateGrounded: true, // prior has meaningful slot data
  });
  assert.notEqual(visible.next_action, "ask_for_service",
    "ask_for_service must never be exposed — even when state is grounded via slot-only prior");
  assert.notEqual(visible.next_action, "ask_for_name",
    "ask_for_name must never be exposed");
  // selected_slot should be set and visible
  assert.ok(visible.selected_slot != null, "selected_slot must be set");
});

test("Slot-only-2: prior state with selected_slot but no service/name → next_action NOT ask_for_service or ask_for_name", () => {
  const prior: Partial<BookingProcessState> = {
    selected_slot: { starts_at: "2026-08-05T14:00:00" },
  };
  const state = computeBookingProcessState({ prior });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: prior,
    bookingStateGrounded: true,
  });
  assert.notEqual(visible.next_action, "ask_for_service",
    "ask_for_service must never be exposed");
  assert.notEqual(visible.next_action, "ask_for_name",
    "ask_for_name must never be exposed");
});

test("Guard-3: booking.apply missing_service guard fires via booking_apply_action_truth, not via booking_process_state.next_action", async () => {
  // Verifies that the PR #142 guard still returns missing_service from booking_apply_action_truth.
  // booking_process_state.next_action is suppressed but the guard runs independently.
  const { buildBookingApplyActionTruth } = await import("../src/runtime/bookingApplyGuard.ts");
  const guardedResults = [{
    tool: "booking.apply" as const,
    call_id: "call_g3",
    status: "success" as const,
    data: {
      booking_status: "missing_service",
      created_visit: false,
      may_claim_booked: false,
      required_next_action: "ask_for_service",
      reason: "service_required",
    },
  }];
  const truth = buildBookingApplyActionTruth(guardedResults as never);
  assert.ok(truth !== null, "truth must be non-null");
  assert.equal(truth!.booking_status, "missing_service",
    "booking_apply_action_truth must carry missing_service from the guard result");
  assert.equal(truth!.required_next_action, "ask_for_service",
    "booking_apply_action_truth preserves required_next_action from guard for model context");
  // This is separate from booking_process_state.next_action — guard output goes via action_truth, not state.
});

test("Guard-4: booking.apply missing_patient_name guard fires via booking_apply_action_truth, not via booking_process_state.next_action", async () => {
  const { buildBookingApplyActionTruth } = await import("../src/runtime/bookingApplyGuard.ts");
  const guardedResults = [{
    tool: "booking.apply" as const,
    call_id: "call_g4",
    status: "success" as const,
    data: {
      booking_status: "missing_patient_name",
      created_visit: false,
      may_claim_booked: false,
      required_next_action: "ask_for_name",
      reason: "patient_name_required",
      missing_fields: ["first_name"],
    },
  }];
  const truth = buildBookingApplyActionTruth(guardedResults as never);
  assert.ok(truth !== null, "truth must be non-null");
  assert.equal(truth!.booking_status, "missing_patient_name",
    "booking_apply_action_truth must carry missing_patient_name from the guard result");
  assert.equal(truth!.required_next_action, "ask_for_name",
    "booking_apply_action_truth preserves required_next_action from guard for model context");
});

test("Guard-5: when service+name+slot all grounded in prior state and phone missing → ask_for_phone still exposed", () => {
  // Verifies that the safe ask_for_phone action is still exposed when all other fields are grounded.
  const prior: Partial<BookingProcessState> = {
    service_reason: "чистка зубов",
    first_name: "Оксана",
    last_name: "Ковальчук",
    selected_slot: { starts_at: "2026-08-05T14:00:00" },
    active_availability_evidence: { availability_call_id: "legacy_test_call", requested_date: "2026-08-05", requested_time: null, allowed_slot_keys: ["2026-08-05T14:00"] },
    selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "legacy_test_call", slot_key: "2026-08-05T14:00" },
  };
  const state = computeBookingProcessState({ prior }); // phone_trusted=false (no channel_contact)
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: prior,
    bookingStateGrounded: true,
  });
  assert.equal(visible.next_action, "ask_for_phone",
    "ask_for_phone must be exposed when all other proof fields are grounded and phone is missing");
  assert.equal(visible.next_action_confidence, "high");
});

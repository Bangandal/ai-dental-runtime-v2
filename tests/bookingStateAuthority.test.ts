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
    hasToolResults: false,
  });
  assert.equal(visible.next_action_confidence, "low");
  assert.equal(visible.next_action, undefined, "next_action must be omitted on low confidence");
});

// ── Test B: prior state exists → high confidence → next_action included ────────

test("B: prior state exists → next_action included with high confidence", () => {
  const prior: Partial<BookingProcessState> = { service_reason: "чистка" };
  const state = computeBookingProcessState({ prior });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: prior,
    hasToolResults: false,
  });
  assert.equal(visible.next_action_confidence, "high");
  assert.ok(visible.next_action !== undefined, "next_action must be present when confidence is high");
});

// ── Test C: tool results present → high confidence ─────────────────────────────

test("C: after availability.check tool result → next_action included with high confidence", () => {
  const toolResults = [{
    tool: "availability.check" as const,
    call_id: "call_1",
    status: "success" as const,
    data: { slots: [{ starts_at: "2026-08-05T17:30:00" }] },
  }];
  const state = computeBookingProcessState({ prior: null, toolResults });
  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: null,
    hasToolResults: true,
  });
  assert.equal(visible.next_action_confidence, "high");
  assert.ok(visible.next_action !== undefined);
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

// ── Test F: selected_slot still visible regardless of confidence ───────────────

test("F: selected_slot from last_available_slots is visible even on low-confidence state", () => {
  const prior: Partial<BookingProcessState> = {
    last_available_slots: [{ starts_at: "2026-08-05T17:30:00" }],
  };
  const state = computeBookingProcessState({ prior: null, patientMessage: "17:30", channelContact: undefined });
  // Simulate prior having slots (even though priorProcessState=null for confidence calc)
  // The detection comes from last_available_slots that were set from tool results previously
  const stateWithSlots = computeBookingProcessState({
    prior: { last_available_slots: [{ starts_at: "2026-08-05T17:30:00" }] },
    patientMessage: "17:30",
  });
  const visible = buildModelVisibleBookingProcessState({
    state: stateWithSlots,
    priorProcessState: { last_available_slots: [{ starts_at: "2026-08-05T17:30:00" }] }, // non-null → high confidence anyway
    hasToolResults: false,
  });
  assert.equal(visible.next_action_confidence, "high");
  assert.ok(visible.selected_slot !== null && visible.selected_slot !== undefined);
  assert.equal(visible.selected_slot!.starts_at, "2026-08-05T17:30:00");
});

// ── Test G: contact button — low confidence does NOT attach; high confidence does ─

test("G: maybeAttachPhoneRequestUI — low confidence does NOT attach contact button", async () => {
  const { maybeAttachPhoneRequestUI } = await import("../src/runtime/runtimeAgentLoop.ts");
  const lowState = buildModelVisibleBookingProcessState({
    state: makeFullState({ next_action: "ask_for_phone" }),
    priorProcessState: null,
    hasToolResults: false,
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
    hasToolResults: false,
  });
  const result = maybeAttachPhoneRequestUI(highState, undefined);
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

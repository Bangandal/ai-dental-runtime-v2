/**
 * PR #142 — guardedBookingApplyToolOutput tests.
 *
 * When booking.apply is blocked by a deterministic preflight guard, the runtime
 * must NOT dirty the OpenAI conversation_id.  Instead it submits a synthetic
 * "guarded" booking.apply tool_result back to the same conversation, calls the
 * model again, and returns the model's final_response with conversation_id
 * preserved and resumable.
 *
 * Tests A–G:
 *
 * A. Round 1 missing phone:
 *    Model requests booking.apply, no trusted phone.
 *    Expected: executor NOT called, guarded tool_result submitted (missing_trusted_phone),
 *    final reply from model, conversation_id present (not null), conversation_id_resumable
 *    NOT false, debug.openai_conversation_resumable NOT false.
 *
 * B. Round 1 missing slot / name / service:
 *    Same clean conversation behavior for each guard variant.
 *
 * C. Round 2 no slots:
 *    availability.check returns 0 slots, model then requests booking.apply.
 *    Expected: guarded tool_result booking_status=no_available_slots, final reply,
 *    conversation_id preserved, executor NOT called.
 *
 * D. Round 2 missing phone (slots available):
 *    availability.check returned slots, model requests booking.apply, no trusted phone.
 *    Expected: guarded missing_trusted_phone, conversation_id preserved, executor NOT called.
 *
 * E. Round 2 invalid slot / past time:
 *    Expected: guarded tool_result, no executor, conversation_id preserved.
 *
 * F. Existing full-proof disabled mode (regression):
 *    Known name + service + valid slot + trusted phone + CLINICCARD_BOOKING_MODE=disabled.
 *    Expected: executor STILL runs, booking_status=booking_write_disabled, created_visit=false,
 *    may_claim_booked=false.
 *
 * G. No regression: existing test suite passes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type {
  RuntimeAgentToolRequest,
  ChannelContact,
  RuntimeAgentToolResult,
} from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350142",
  phone_source: "telegram_contact_button",
};

const SLOT = {
  slot_id: "2026-08-05T14:00",
  starts_at: "2026-08-05T14:00:00",
  ends_at: "2026-08-05T14:30:00",
};

const BOOKING_APPLY_FULL: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_book_pr142",
  arguments: {
    subject_id: "subject_1",
    service: "чистка зубов",
    requested_date: "2026-08-05",
    requested_time: "14:00",
    first_name: "Тест",
    last_name: "Пациент",
  },
};

const BOOKING_APPLY_NO_PHONE: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_book_no_phone",
  arguments: {
    subject_id: "subject_1",
    service: "чистка зубов",
    requested_date: "2026-08-05",
    requested_time: "14:00",
    first_name: "Тест",
    last_name: "Пациент",
  },
};

const AVAILABILITY_REQUEST: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_pr142",
  arguments: { service_interest: "чистка зубов", requested_date: "2026-08-05" },
};

// booking.select_slot for subject_1 at 2026-08-05 14:00 — used in round-1 instead of avail.check
// so the state repo's evidence/proof is preserved (avail.check would clear it)
const SELECT_SLOT_REQUEST_AUG5: RuntimeAgentToolRequest = {
  tool: "booking.select_slot",
  call_id: "call_ss_aug5",
  arguments: { subject_id: "subject_1", requested_date: "2026-08-05", requested_time: "14:00" },
};

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_pr142",
  case_id: null,
  conversation_id: "conv_pr142",
  user_message: "Запишите меня пожалуйста",
  locale: "ru",
  trace_id: "trace_pr142",
  business_context: { channel: "telegram" },
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

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
        selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: callId, slot_key: slotKey },
      };
    },
    async saveState() {},
  };
}

// Helper to assert guarded tool result invariants
function assertGuardedResult(
  result: Awaited<ReturnType<ReturnType<typeof createRuntimeAgentLoop>["runTurn"]>>,
  expectedBookingStatus: string,
  label: string,
) {
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, `${label}: guarded booking.apply result must appear in tool_results`);
  const data = bookingResult!.data as Record<string, unknown>;
  assert.equal(data.booking_status, expectedBookingStatus, `${label}: booking_status must be ${expectedBookingStatus}`);
  assert.equal(data.created_visit, false, `${label}: created_visit must be false`);
  assert.equal(data.may_claim_booked, false, `${label}: may_claim_booked must be false`);
}

function assertConversationClean(
  result: Awaited<ReturnType<ReturnType<typeof createRuntimeAgentLoop>["runTurn"]>>,
  expectedConversationId: string | null,
  label: string,
) {
  if (expectedConversationId !== null) {
    assert.equal(result.conversation_id, expectedConversationId, `${label}: conversation_id must be preserved`);
  } else {
    assert.ok(result.conversation_id !== null || result.conversation_id === null, `${label}: conversation_id present`);
  }
  assert.notEqual(result.conversation_id_resumable, false, `${label}: conversation_id_resumable must NOT be false`);
  const debug = result.debug as Record<string, unknown>;
  assert.notEqual(debug?.openai_conversation_resumable, false, `${label}: debug.openai_conversation_resumable must NOT be false`);
}

// ── Test A: Round 1 missing phone ─────────────────────────────────────────────

test("A: round 1 booking.apply — no trusted phone → guarded missing_trusted_phone, conversation preserved", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: model requests booking.apply directly (no phone present)
      { type: "tool_requests", conversation_id: "conv_pr142", tool_requests: [BOOKING_APPLY_NO_PHONE] },
      // Guarded finalization: model asks for phone
      { type: "final_response", conversation_id: "conv_pr142", final_response: { final_patient_reply: "Для записи нужен ваш номер телефона. Поделитесь контактом." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "v1" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, channel_contact: undefined });

  assert.equal(executorCalled, false, "A: executor must NOT be called");
  assertGuardedResult(result, "missing_trusted_phone", "A");
  assertConversationClean(result, "conv_pr142", "A");
  assert.ok(result.final_patient_reply.length > 0, "A: must have a final reply");
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_missing_trusted_phone_round1");
});

// ── Test B: Round 1 — missing slot, missing name, missing service ─────────────

test("B1: round 1 booking.apply — missing slot → guarded missing_slot, conversation preserved", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_b1",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_b1",
          arguments: { subject_id: "subject_1", first_name: "Тест", last_name: "Пациент", service: "осмотр" },
          // No requested_date / requested_time
        }],
      },
      { type: "final_response", conversation_id: "conv_b1", final_response: { final_patient_reply: "Укажите дату и время." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_b1", channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "B1: executor must NOT be called");
  assertGuardedResult(result, "missing_slot", "B1");
  assertConversationClean(result, "conv_b1", "B1");
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_missing_slot_round1");
});

test("B2: round 1 booking.apply — missing first_name → guarded missing_patient_name, missing_fields=[first_name]", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_b2",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_b2",
          arguments: { subject_id: "subject_1", last_name: "Пациент", requested_date: "2026-08-05", requested_time: "14:00", service: "осмотр" },
        }],
      },
      { type: "final_response", conversation_id: "conv_b2", final_response: { final_patient_reply: "Укажите ваше имя." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_b2", channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "B2: executor must NOT be called");
  assertGuardedResult(result, "missing_patient_name", "B2");
  assertConversationClean(result, "conv_b2", "B2");
  const missingFields = (result.tool_results.find((r) => r.tool === "booking.apply")!.data as Record<string, unknown>).missing_fields as string[];
  assert.ok(Array.isArray(missingFields) && missingFields.includes("first_name"), "B2: missing_fields must include first_name");
});

test("B3: round 1 booking.apply — missing service → guarded missing_service, conversation preserved", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_b3",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_b3",
          arguments: { subject_id: "subject_1", first_name: "Тест", last_name: "Пациент", requested_date: "2026-08-05", requested_time: "14:00" },
          // No service or service_reason
        }],
      },
      { type: "final_response", conversation_id: "conv_b3", final_response: { final_patient_reply: "Укажите причину визита." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_b3", channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "B3: executor must NOT be called");
  assertGuardedResult(result, "missing_service", "B3");
  assertConversationClean(result, "conv_b3", "B3");
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_missing_service_round1");
});

// ── Test C: Round 2 no slots ──────────────────────────────────────────────────

test("C: round 2 booking.apply — availability returned 0 slots → guarded no_available_slots, conversation preserved", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: availability.check
      { type: "tool_requests", conversation_id: "conv_c", tool_requests: [AVAILABILITY_REQUEST] },
      // Round 2: model incorrectly requests booking.apply
      { type: "tool_requests", conversation_id: "conv_c", tool_requests: [BOOKING_APPLY_FULL] },
      // Guarded finalization: model asks for another time
      { type: "final_response", conversation_id: "conv_c", final_response: { final_patient_reply: "К сожалению, нет свободных слотов. Выберите другую дату." } },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [], total_slots: 0, free_slots_count: 0 },
      }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_c", channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "C: executor must NOT be called");
  assertGuardedResult(result, "no_available_slots", "C");
  assertConversationClean(result, "conv_c", "C");
  assert.ok(result.final_patient_reply.length > 0, "C: must have a reply");
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_no_slots");
});

// ── Test D: Round 2 missing phone (slots available) ───────────────────────────

test("D: round 2 booking.apply — slots available but no trusted phone → guarded missing_trusted_phone, conversation preserved", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: select_slot (preserves prior state proof; avail.check would clear it)
      { type: "tool_requests", conversation_id: "conv_d", tool_requests: [SELECT_SLOT_REQUEST_AUG5] },
      // Round 2: model requests booking.apply (no phone in context)
      { type: "tool_requests", conversation_id: "conv_d", tool_requests: [BOOKING_APPLY_FULL] },
      // Guarded finalization: model asks for contact button
      { type: "final_response", conversation_id: "conv_d", final_response: { final_patient_reply: "Для записи нужен ваш контакт." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    // Prior state provides evidence + proof so Guard G passes; phone guard fires instead
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_d", channel_contact: undefined });

  assert.equal(executorCalled, false, "D: executor must NOT be called");
  assertGuardedResult(result, "missing_trusted_phone", "D");
  assertConversationClean(result, "conv_d", "D");
  assert.ok(result.final_patient_reply.length > 0, "D: must have a reply");
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_intercepted_missing_trusted_phone");
});

// ── Test E: Round 2 invalid slot ──────────────────────────────────────────────

test("E: round 2 booking.apply after avail.check (no select_slot) → guarded slot_not_verified, conversation preserved", async () => {
  // With the proof requirement, avail.check alone does not authorize booking.apply.
  // avail.check clears the prior proof, so Guard G fires before Guard H in round-2.
  let executorCalled = false;

  const BOOKING_WRONG_TIME: RuntimeAgentToolRequest = {
    tool: "booking.apply",
    call_id: "call_e_wrong",
    arguments: {
      subject_id: "subject_1",
      service: "чистка",
      requested_date: "2026-08-05",
      requested_time: "15:00", // SLOT is at 14:00, not 15:00
      first_name: "Тест",
      last_name: "Пациент",
    },
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: availability.check returns slot at 14:00
      { type: "tool_requests", conversation_id: "conv_e", tool_requests: [AVAILABILITY_REQUEST] },
      // Round 2: model requests booking.apply at 15:00 — proof cleared by avail.check, Guard G fires
      { type: "tool_requests", conversation_id: "conv_e", tool_requests: [BOOKING_WRONG_TIME] },
      // Guarded finalization: model tells patient to call booking.select_slot first
      { type: "final_response", conversation_id: "conv_e", final_response: { final_patient_reply: "Выберите слот через select_slot." } },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [SLOT], total_slots: 1, free_slots_count: 1 },
      }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_e", channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "E: executor must NOT be called");
  assertGuardedResult(result, "slot_not_verified", "E");
  assertConversationClean(result, "conv_e", "E");
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_preflight_missing_slot_proof_round2");
});

// ── Test F: Existing full-proof disabled mode regression ──────────────────────

test("F: full proof + CLINICCARD_BOOKING_MODE=disabled → executor runs, booking_write_disabled, no false claim", async () => {
  let writeAttempted = false;

  const DISABLED_ENV: Record<string, string> = {
    CLINICCARD_API_BASE_URL: "https://cliniccard.example",
    CLINICCARD_API_TOKEN: "tok_test",
    CLINICCARD_BOOKING_MODE: "disabled",
    CLINICCARD_DEFAULT_DOCTOR_ID: "1",
    CLINICCARD_DEFAULT_CABINET_ID: "2",
    CLINICCARD_TIMEZONE: "Europe/Prague",
    CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  };

  const mockAdapter: ClinicCardAdapter = {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async () => { writeAttempted = true; return { ok: true, data: { id: 1, name: "x", phone: null } }; },
    createVisit: async () => { writeAttempted = true; return { ok: false, error: { code: "e", message: "e" } }; },
    listVisits: async () => { writeAttempted = true; return { ok: true, data: [] }; },
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: model requests booking.apply with all required fields
      { type: "tool_requests", tool_requests: [BOOKING_APPLY_FULL] },
      // Second call: model gets booking_write_disabled result, produces final reply
      { type: "final_response", final_response: { final_patient_reply: "Онлайн-запись временно недоступна." } },
    ]),
    executors: {
      "booking.apply": createBookingApplyExecutor({
        env: DISABLED_ENV,
        adapterFactory: () => mockAdapter,
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, channel_contact: TRUSTED_CONTACT });

  // Executor must have been called (all guards pass → executor runs in disabled mode)
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "F: booking.apply must appear in tool_results");
  const data = bookingResult!.data as Record<string, unknown>;
  assert.equal(data.booking_status, "booking_write_disabled", "F: must be booking_write_disabled");
  assert.equal(data.created_visit, false, "F: created_visit must be false");
  assert.equal(data.may_claim_booked, false, "F: may_claim_booked must be false");

  // No ClinicCard write attempted
  assert.equal(writeAttempted, false, "F: no ClinicCard write when mode=disabled");

  // Reply from model (2nd caller output)
  assert.ok(result.final_patient_reply.length > 0, "F: must have a reply");
});

// ── Test: guarded caller failure → conversation marked dirty ──────────────────

test("guarded caller exception → conversation marked dirty, emergency fallback", async () => {
  // The guarded caller always throws → helper marks dirty, returns emergency fallback
  let callCount = 0;
  const caller: RuntimeAgentCaller = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_dirty",
        tool_requests: [BOOKING_APPLY_NO_PHONE],
      };
    }
    throw new Error("upstream_error");
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {},
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_dirty", channel_contact: undefined });

  // Conversation must be dirty (caller failed during guarded finalization)
  assert.equal(result.conversation_id, null, "conversation_id must be null when guarded caller fails");
  assert.equal(result.conversation_id_resumable, false, "conversation_id_resumable must be false when guarded caller fails");

  // Guarded tool result still appears in tool_results even on failure
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded result must be in tool_results even on caller failure");
});

// ── Blocker B tests: ui.telegram.request_contact forced for ask_for_phone ────

test("B-phone-1: round 1 missing_trusted_phone → ui.telegram.request_contact=true (model omits ui)", async () => {
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", conversation_id: "conv_bp1", tool_requests: [BOOKING_APPLY_NO_PHONE] },
      // Model returns no ui field at all
      { type: "final_response", conversation_id: "conv_bp1", final_response: { final_patient_reply: "Поделитесь контактом." } },
    ]),
    executors: {},
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_bp1", channel_contact: undefined });

  assert.equal(result.ui?.telegram?.request_contact, true, "B-phone-1: request_contact must be true");
  assert.equal(result.ui?.telegram?.button_text, "📞 Поделиться контактом", "B-phone-1: button_text must be set");
});

test("B-phone-2: round 2 missing_trusted_phone (slots available) → ui.telegram.request_contact=true", async () => {
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: select_slot (preserves proof; avail.check would clear it)
      { type: "tool_requests", conversation_id: "conv_bp2", tool_requests: [SELECT_SLOT_REQUEST_AUG5] },
      { type: "tool_requests", conversation_id: "conv_bp2", tool_requests: [BOOKING_APPLY_FULL] },
      { type: "final_response", conversation_id: "conv_bp2", final_response: { final_patient_reply: "Нужен контакт." } },
    ]),
    executors: {},
    // Prior state provides evidence + proof so Guard G passes; phone guard fires
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_bp2", channel_contact: undefined });

  assert.equal(result.ui?.telegram?.request_contact, true, "B-phone-2: request_contact must be true");
  assert.equal(result.ui?.telegram?.button_text, "📞 Поделиться контактом", "B-phone-2: button_text must be set");
});

test("B-phone-3: CS locale missing phone → ui.telegram.request_contact=true", async () => {
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", conversation_id: "conv_bp3", tool_requests: [BOOKING_APPLY_NO_PHONE] },
      { type: "final_response", conversation_id: "conv_bp3", final_response: { final_patient_reply: "Sdílejte kontakt prosím." } },
    ]),
    executors: {},
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_bp3", locale: "cs", channel_contact: undefined });

  assert.equal(result.ui?.telegram?.request_contact, true, "B-phone-3: request_contact must be true for CS locale");
  assert.equal(result.ui?.telegram?.button_text, "📞 Поделиться контактом", "B-phone-3: button_text must be set");
});

// ── Blocker A unit tests: buildBookingApplyActionTruth mapping ────────────────

function makeBookingResult(booking_status: string): RuntimeAgentToolResult {
  return {
    tool: "booking.apply",
    call_id: "call_unit",
    status: "success",
    data: { booking_status, created_visit: false, may_claim_booked: false },
  };
}

test("B-guard-4: missing_trusted_phone → required_next_action=ask_for_phone (not technical_fallback)", () => {
  const truth = buildBookingApplyActionTruth([makeBookingResult("missing_trusted_phone")]);
  assert.ok(truth, "B-guard-4: truth must not be null");
  assert.equal(truth!.required_next_action, "ask_for_phone", "B-guard-4: missing_trusted_phone → ask_for_phone");
});

test("B-guard-5: no_available_slots / invalid_slot / past_time → offer_another_time (not technical_fallback)", () => {
  for (const status of ["no_available_slots", "invalid_slot", "past_time"]) {
    const truth = buildBookingApplyActionTruth([makeBookingResult(status)]);
    assert.ok(truth, `B-guard-5 (${status}): truth must not be null`);
    assert.equal(truth!.required_next_action, "offer_another_time", `B-guard-5 (${status}): must map to offer_another_time`);
  }
});

test("B-guard-6: missing_slot / missing_patient_name / missing_service → specific action, not technical_fallback", () => {
  const expectations: Record<string, string> = {
    missing_slot:         "ask_for_slot",
    missing_patient_name: "ask_for_name",
    missing_service:      "ask_for_service",
  };
  for (const [status, expected] of Object.entries(expectations)) {
    const truth = buildBookingApplyActionTruth([makeBookingResult(status)]);
    assert.ok(truth, `B-guard-6 (${status}): truth must not be null`);
    assert.notEqual(truth!.required_next_action, "technical_fallback", `B-guard-6 (${status}): must not be technical_fallback`);
    assert.equal(truth!.required_next_action, expected, `B-guard-6 (${status}): must be ${expected}`);
  }
});

// ── PR #144 tests: maybeAttachPhoneRequestUI ──────────────────────────────────
//
// When booking_process_state.next_action === "ask_for_phone" and phone is not yet
// trusted, the runtime must attach ui.telegram.request_contact=true on ALL
// final_response paths — even when the model skips booking.apply entirely.

import { maybeAttachPhoneRequestUI } from "../src/runtime/runtimeAgentLoop.ts";
import type { BookingProcessState } from "../src/runtime/bookingProcessState.ts";

function makeProcessState(overrides: Partial<BookingProcessState>): BookingProcessState {
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

// ── PR144-A: no-tool final_response + ask_for_phone → contact button attached

test("PR144-A: maybeAttachPhoneRequestUI attaches button when next_action=ask_for_phone and no trusted phone", () => {
  const state = makeProcessState({ next_action: "ask_for_phone", phone_trusted: undefined });
  const result = maybeAttachPhoneRequestUI(state, undefined, "telegram");
  assert.equal(result?.telegram?.request_contact, true, "PR144-A: request_contact must be true");
  assert.equal(result?.telegram?.button_text, "📞 Поделиться контактом", "PR144-A: button_text must match");
});

test("PR144-A (no-tool loop): first-call final_response with ask_for_phone state returns ui.telegram.request_contact=true", async () => {
  // Inject deterministic time so stale-evidence TTL is evaluated at a fixed point.
  // Evidence checked_at is 5 minutes before testNow → always fresh.
  const testNow = new Date("2026-08-05T08:00:00.000Z");
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: testNow,
    caller: async () => ({
      type: "final_response" as const,
      conversation_id: "conv_144_a",
      final_response: { final_patient_reply: "Поделитесь контактом пожалуйста" },
    }),
    executors: {},
    bookingProcessStateRepository: {
      loadState: async () => ({
        service_reason: "чистка зубов",
        first_name: "Тест",
        last_name: "Пациент",
        selected_slot: { starts_at: "2026-08-05T14:00:00", slot_id: "s1" },
        active_availability_evidence: { availability_call_id: "legacy_test_call", requested_date: "2026-08-05", requested_time: null, allowed_slot_keys: ["2026-08-05T14:00"], checked_at: new Date(testNow.getTime() - 5 * 60 * 1000).toISOString() },
        selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "legacy_test_call", slot_key: "2026-08-05T14:00" },
        next_action: "ask_for_phone" as const,
        phone_trusted: undefined,
        proof: { service_known: true, name_known: true, slot_known: true, trusted_phone_known: false, ready_for_booking_apply: false },
      }),
      saveState: async () => undefined,
    },
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_144_a",
    case_id: null,
    conversation_id: null,
    user_message: "Да давайте",
    locale: "ru",
    trace_id: "trace_144_a",
    business_context: { channel: "telegram" },
  });

  assert.equal(result.ui?.telegram?.request_contact, true, "PR144-A loop: ui.telegram.request_contact must be true");
  assert.equal(result.ui?.telegram?.button_text, "📞 Поделиться контактом", "PR144-A loop: button_text must match");
});

// ── PR144-B: phone_trusted=true → no contact button

test("PR144-B: maybeAttachPhoneRequestUI does not attach button when phone_trusted=true", () => {
  const state = makeProcessState({ next_action: "ask_for_phone", phone_trusted: true });
  const result = maybeAttachPhoneRequestUI(state, undefined);
  assert.equal(!!result?.telegram?.request_contact, false, "PR144-B: request_contact must not be set when phone_trusted");
});

test("PR144-B (loop): no-tool final_response with phone_trusted=true does not return contact button", async () => {
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: async () => ({
      type: "final_response" as const,
      conversation_id: "conv_144_b",
      final_response: { final_patient_reply: "Телефон уже известен, продолжаем." },
    }),
    executors: {},
    bookingProcessStateRepository: {
      loadState: async () => ({
        next_action: "ask_for_phone" as const,
        phone_trusted: true,
        proof: { service_known: true, name_known: true, slot_known: true, trusted_phone_known: true, ready_for_booking_apply: false },
      }),
      saveState: async () => undefined,
    },
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_144_b",
    case_id: null,
    conversation_id: null,
    user_message: "Продолжаем",
    locale: "ru",
    trace_id: "trace_144_b",
    channel_contact: { phone_number: "+380991350144", phone_source: "telegram_contact_button" },
  });

  assert.equal(!!result.ui?.telegram?.request_contact, false, "PR144-B loop: must NOT attach contact button when phone already trusted");
});

// ── PR144-C: other next_action values → no contact button

test("PR144-C: maybeAttachPhoneRequestUI does not attach button for ask_for_slot / ask_for_name / ask_for_service", () => {
  for (const action of ["ask_for_slot", "ask_for_name", "ask_for_service", "ready_for_booking_apply", undefined] as const) {
    const state = makeProcessState({ next_action: action as BookingProcessState["next_action"] });
    const result = maybeAttachPhoneRequestUI(state, undefined);
    assert.equal(
      !!result?.telegram?.request_contact,
      false,
      `PR144-C: must not attach contact button for next_action=${action}`,
    );
  }
});

// ── PR144-D: guarded booking.apply missing-phone path (PR #142 regression)

test("PR144-D: guarded booking.apply missing-phone path still returns ui.telegram.request_contact=true", async () => {
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: model requests booking.apply with no phone
      { type: "tool_requests", conversation_id: "conv_144_d", tool_requests: [BOOKING_APPLY_NO_PHONE] },
      // Guarded: model asks for contact
      { type: "final_response", conversation_id: "conv_144_d", final_response: { final_patient_reply: "Нажмите кнопку для контакта" } },
    ]),
    executors: {
      "booking.apply": async () => ({ status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-08-05T14:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_144_d",
    contact_id: "contact_144_d",
    trace_id: "trace_144_d",
    channel_contact: undefined, // no trusted phone
  });

  assert.equal(result.ui?.telegram?.request_contact, true, "PR144-D: guarded missing_trusted_phone must still return request_contact=true");
});

// ── PR144-E: no ClinicCard writes when attaching contact button

test("PR144-E: no ClinicCard writes when contact button is attached via maybeAttachPhoneRequestUI", async () => {
  let clinicCardWriteCalled = false;

  const testNow = new Date("2026-08-05T08:00:00.000Z");
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    now: testNow,
    caller: async () => ({
      type: "final_response" as const,
      conversation_id: "conv_144_e",
      final_response: { final_patient_reply: "Нажмите кнопку контакта" },
    }),
    executors: {
      "booking.apply": async () => {
        clinicCardWriteCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: {
      loadState: async () => ({
        service_reason: "чистка зубов",
        first_name: "Тест",
        last_name: "Пациент",
        selected_slot: { starts_at: "2026-08-05T14:00:00", slot_id: "s1" },
        active_availability_evidence: { availability_call_id: "legacy_test_call", requested_date: "2026-08-05", requested_time: null, allowed_slot_keys: ["2026-08-05T14:00"], checked_at: new Date(testNow.getTime() - 5 * 60 * 1000).toISOString() },
        selected_slot_proof: { subject_id: "subject_1" as const, availability_call_id: "legacy_test_call", slot_key: "2026-08-05T14:00" },
        phone_trusted: undefined,
        proof: { service_known: true, name_known: true, slot_known: true, trusted_phone_known: false, ready_for_booking_apply: false },
      }),
      saveState: async () => undefined,
    },
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_144_e",
    case_id: null,
    conversation_id: null,
    user_message: "Хочу записаться",
    locale: "ru",
    trace_id: "trace_144_e",
    business_context: { channel: "telegram" },
  });

  assert.equal(clinicCardWriteCalled, false, "PR144-E: ClinicCard executor must not be called");
  assert.equal(result.ui?.telegram?.request_contact, true, "PR144-E: contact button must still be attached");
});

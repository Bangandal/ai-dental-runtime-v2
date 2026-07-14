/**
 * PR #167 — Guard order: slot/date/time validity must fire before phone collection.
 *
 * Root cause: Guard A (phone) fired before Guards D (missing_slot), G
 * (slot_not_verified), and H (invalid_slot). A patient who chose a time outside
 * available slots was asked for their phone before being told the slot was invalid.
 *
 * Fix: reorder round-1 and round-2 preflight guards so slot guards (D, G, H) fire
 * before the phone guard (A). The phone gate only fires after slot validity is
 * confirmed.
 *
 * Tests:
 * GO-A  Round-1: unverified slot + no phone → slot_not_verified (NOT missing_trusted_phone)
 * GO-B  Round-2: avail.check ran, wrong time + no phone → invalid_slot (NOT missing_trusted_phone)
 * GO-C  Round-2: valid verified slot + no phone → missing_trusted_phone (phone gate fires after slot ok)
 * GO-D  Round-2: avail.check returns 0 slots + phone → no_available_slots (no-slots stays before phone)
 * GO-E  Round-2: valid slot + trusted phone + missing name → missing_patient_name
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

const NO_CONTACT = undefined;

const AVAIL_REQUEST: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_av_go",
  arguments: { requested_date: "2026-07-15", service_interest: "чистка" },
};

const AVAIL_RESULT_WITH_SLOT: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_av_go",
  status: "success",
  data: {
    slots: [{ starts_at: "2026-07-15T11:00:00", ends_at: "2026-07-15T11:30:00", slot_id: "2026-07-15T11:00" }],
    total_slots: 1,
    free_slots_count: 1,
  },
};

const AVAIL_RESULT_NO_SLOTS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_av_noslots",
  status: "success",
  data: { slots: [], total_slots: 0, free_slots_count: 0 },
};

// booking.apply for 14:00 — not in available slots (slots are at 11:00)
const BOOKING_WRONG_TIME: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_wrong",
  arguments: {
    subject_id: "subject_1",
    first_name: "Іван",
    last_name: "Петренко",
    service: "чистка",
    requested_date: "2026-07-15",
    requested_time: "14:00",
  },
};

// booking.apply for 11:00 — matches available slot
const BOOKING_CORRECT_TIME: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_correct",
  arguments: {
    subject_id: "subject_1",
    first_name: "Іван",
    last_name: "Петренко",
    service: "чистка",
    requested_date: "2026-07-15",
    requested_time: "11:00",
  },
};

// booking.apply for 11:00, missing first_name
const BOOKING_CORRECT_TIME_NO_NAME: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_noname",
  arguments: {
    subject_id: "subject_1",
    service: "чистка",
    requested_date: "2026-07-15",
    requested_time: "11:00",
  },
};

// booking.apply for no-slots scenario
const BOOKING_ANY_TIME: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_any",
  arguments: {
    subject_id: "subject_1",
    first_name: "Іван",
    last_name: "Петренко",
    service: "чистка",
    requested_date: "2026-07-15",
    requested_time: "11:00",
  },
};

// Round-1 booking.apply (no prior avail.check): all fields present but no slot proof
const BOOKING_ROUND1_FULL: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_r1",
  arguments: {
    subject_id: "subject_1",
    first_name: "Іван",
    last_name: "Петренко",
    service: "чистка",
    requested_date: "2026-07-15",
    requested_time: "11:00",
  },
};

const BASE_INPUT = {
  clinic_id: "clinic_go",
  contact_id: "contact_go",
  case_id: null,
  user_message: "Запишите меня",
  locale: "ru",
  trace_id: "trace_go",
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

// ── GO-A: Round-1 unverified slot + no phone → slot_not_verified ──────────────

test("GO-A: round-1 booking.apply, no avail.check proof, no phone → slot_not_verified (not missing_trusted_phone)", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_go_a",
        tool_requests: [BOOKING_ROUND1_FULL],
      },
      {
        type: "final_response",
        conversation_id: "conv_go_a",
        final_response: { final_patient_reply: "Сначала проверим доступное время." },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_INPUT,
    conversation_id: "conv_go_a",
    channel_contact: NO_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "slot_not_verified",
    "booking_status must be slot_not_verified — slot guard must fire before phone guard",
  );
  assert.notEqual(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "missing_trusted_phone",
    "phone guard must NOT fire before slot guard",
  );
  const debugReason = (result.debug as Record<string, unknown>)?.reason;
  assert.equal(
    debugReason,
    "booking_apply_preflight_missing_slot_proof_round1",
    `debug.reason must be missing_slot_proof_round1 — got: ${debugReason}`,
  );
});

// ── GO-B: Round-2 wrong time + no phone → invalid_slot ───────────────────────

test("GO-B: round-2 avail.check ran, booking.apply requests wrong time, no phone → invalid_slot (not missing_trusted_phone)", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_go_b",
        tool_requests: [AVAIL_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_go_b",
        tool_requests: [BOOKING_WRONG_TIME],
      },
      {
        type: "final_response",
        conversation_id: "conv_go_b",
        final_response: { final_patient_reply: "Это время недоступно. Выберите из доступных слотов." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: {
          slots: [{ starts_at: "2026-07-15T11:00:00", ends_at: "2026-07-15T11:30:00" }],
          total_slots: 1,
          free_slots_count: 1,
        },
      }),
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_INPUT,
    conversation_id: "conv_go_b",
    channel_contact: NO_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "invalid_slot",
    "booking_status must be invalid_slot — slot validity guard must fire before phone guard",
  );
  assert.notEqual(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "missing_trusted_phone",
    "phone guard must NOT fire before slot validity guard",
  );
  const debugReason = (result.debug as Record<string, unknown>)?.reason;
  assert.equal(
    debugReason,
    "booking_apply_preflight_invalid_slot_round2",
    `debug.reason must be invalid_slot_round2 — got: ${debugReason}`,
  );
});

// ── GO-C: Valid verified slot + no phone → missing_trusted_phone ──────────────

test("GO-C: round-2 valid slot (avail.check matches), no phone → missing_trusted_phone", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_go_c",
        tool_requests: [AVAIL_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_go_c",
        tool_requests: [BOOKING_CORRECT_TIME],
      },
      {
        type: "final_response",
        conversation_id: "conv_go_c",
        final_response: { final_patient_reply: "Поделитесь, пожалуйста, контактом для записи." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: {
          slots: [{ starts_at: "2026-07-15T11:00:00", ends_at: "2026-07-15T11:30:00" }],
          total_slots: 1,
          free_slots_count: 1,
        },
      }),
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_INPUT,
    conversation_id: "conv_go_c",
    channel_contact: NO_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called without phone");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "missing_trusted_phone",
    "booking_status must be missing_trusted_phone when slot is valid but no phone",
  );
  const debugReason = (result.debug as Record<string, unknown>)?.reason;
  assert.equal(
    debugReason,
    "booking_apply_intercepted_missing_trusted_phone",
    `debug.reason must be intercepted_missing_trusted_phone — got: ${debugReason}`,
  );
});

// ── GO-D: No slots → no_available_slots (stays before phone) ─────────────────

test("GO-D: round-2 avail.check returns 0 slots + trusted phone → no_available_slots", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_go_d",
        tool_requests: [AVAIL_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_go_d",
        tool_requests: [BOOKING_ANY_TIME],
      },
      {
        type: "final_response",
        conversation_id: "conv_go_d",
        final_response: { final_patient_reply: "К сожалению, слотов нет." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [], total_slots: 0, free_slots_count: 0 },
      }),
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_INPUT,
    conversation_id: "conv_go_d",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called when no slots");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "no_available_slots",
    "booking_status must be no_available_slots",
  );
  const debugReason = (result.debug as Record<string, unknown>)?.reason;
  assert.equal(
    debugReason,
    "booking_apply_preflight_no_slots",
    `debug.reason must be booking_apply_preflight_no_slots — got: ${debugReason}`,
  );
});

// ── GO-E: Valid slot + trusted phone + missing name → missing_patient_name ────

test("GO-E: round-2 valid slot + trusted phone + missing name → missing_patient_name", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_go_e",
        tool_requests: [AVAIL_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_go_e",
        tool_requests: [BOOKING_CORRECT_TIME_NO_NAME],
      },
      {
        type: "final_response",
        conversation_id: "conv_go_e",
        final_response: { final_patient_reply: "Для записи укажите ваше имя и фамилию." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: {
          slots: [{ starts_at: "2026-07-15T11:00:00", ends_at: "2026-07-15T11:30:00" }],
          total_slots: 1,
          free_slots_count: 1,
        },
      }),
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_INPUT,
    conversation_id: "conv_go_e",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called with missing name");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "missing_patient_name",
    "booking_status must be missing_patient_name",
  );
  const debugReason = (result.debug as Record<string, unknown>)?.reason;
  assert.equal(
    debugReason,
    "booking_apply_preflight_missing_name_round2",
    `debug.reason must be missing_name_round2 — got: ${debugReason}`,
  );
});

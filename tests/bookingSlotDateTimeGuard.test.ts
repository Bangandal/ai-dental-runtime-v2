/**
 * PR #163 blocker fix — shouldInterceptInvalidSlotDateTime validates full date+time.
 *
 * Bug: shouldInterceptInvalidSlotTime only matched HH:MM, allowing cross-date booking
 * when the same time existed on a different date than what availability.check returned.
 *
 * Fix: shouldInterceptInvalidSlotDateTime compares "YYYY-MM-DDTHH:MM" pairs, blocking
 * any booking.apply whose requested_date+requested_time isn't in the returned slots.
 *
 * 3 unit tests + 2 integration tests (BSDT-1 through BSDT-5).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldInterceptInvalidSlotDateTime,
  shouldInterceptMissingSlotProof,
} from "../src/runtime/bookingApplyPreflight.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";
import type { AvailableSlot } from "../src/runtime/bookingProcessState.ts";
import type { AuthoritativeAvailabilityAttempt } from "../src/runtime/availabilityActionTruth.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "../src/runtime/slotEvidence.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

// availability.check result: slot on 2026-07-10 at 12:00 (future date, avoids past-time guard)
const AVAIL_JULY_10_1200: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_av_dt1",
  status: "success",
  data: {
    slots: [{ starts_at: "2026-07-10T12:00:00", ends_at: "2026-07-10T12:30:00", slot_id: "2026-07-10T12:00" }],
    total_slots: 1,
    free_slots_count: 1,
  },
};

// booking.apply with wrong date (2026-07-11, future but different from slot on 2026-07-10)
const BOOKING_WRONG_DATE: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_dt1",
  arguments: {
    subject_id: "subject_1",
    first_name: "Роман",
    last_name: "Анбасадоров",
    service: "чистка",
    requested_date: "2026-07-11",
    requested_time: "12:00",
  },
};

// booking.apply with correct date (2026-07-10) and correct time (12:00)
const BOOKING_CORRECT_DATE: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_dt2",
  arguments: {
    subject_id: "subject_1",
    first_name: "Роман",
    last_name: "Анбасадоров",
    service: "чистка",
    requested_date: "2026-07-10",
    requested_time: "12:00",
  },
};

const AVAILABILITY_REQUEST: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_av_dt1",
  arguments: { requested_date: "2026-07-10", service_interest: "чистка" },
};

const SUCCESS_ATTEMPT_JULY10: AuthoritativeAvailabilityAttempt = {
  attempted: true,
  request: AVAILABILITY_REQUEST,
  pair: { request: AVAILABILITY_REQUEST, result: AVAIL_JULY_10_1200 },
};

const NO_ATTEMPT: AuthoritativeAvailabilityAttempt = { attempted: false, request: null, pair: null };

const EVIDENCE_JULY10: AvailabilityEvidence = {
  availability_call_id: "call_av_dt1",
  requested_date: "2026-07-10",
  requested_time: null,
  allowed_slot_keys: ["2026-07-10T12:00"],
};

const SLOT_PROOF_JULY10: SelectedSlotProof = {
  availability_call_id: "call_av_dt1",
  slot_key: "2026-07-10T12:00",
};

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_dt",
  case_id: null,
  user_message: "Запишите меня",
  locale: "ru",
  trace_id: "trace_bsdt",
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

// ── Unit: shouldInterceptInvalidSlotDateTime / shouldInterceptMissingSlotProof ─

test("BSDT-3: shouldInterceptInvalidSlotDateTime — same time, different date → true (blocked)", () => {
  // Current-turn avail has slot on 2026-07-10; booking requests 2026-07-11 at same time.
  assert.equal(
    shouldInterceptInvalidSlotDateTime({
      pendingToolRequests: [BOOKING_WRONG_DATE],
      currentAvailabilityAttempt: SUCCESS_ATTEMPT_JULY10,
      activeAvailabilityEvidence: EVIDENCE_JULY10,
      selectedSlot: null,
      selectedSlotProof: null,
    }),
    true,
  );
});

test("BSDT-4: shouldInterceptMissingSlotProof — selectedSlot without proof → intercepts (provenance required)", () => {
  // Selected slot matches the request but there is no selectedSlotProof — must intercept.
  const matchingSlot: AvailableSlot = { starts_at: "2026-07-10T12:00:00" };
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_CORRECT_DATE],
      currentAvailabilityAttempt: NO_ATTEMPT,
      activeAvailabilityEvidence: EVIDENCE_JULY10,
      selectedSlot: matchingSlot,
      selectedSlotProof: null,
    }),
    true,
  );
});

test("BSDT-4b: shouldInterceptMissingSlotProof — selectedSlot with valid proof → does NOT intercept", () => {
  const matchingSlot: AvailableSlot = { starts_at: "2026-07-10T12:00:00" };
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_CORRECT_DATE],
      currentAvailabilityAttempt: NO_ATTEMPT,
      activeAvailabilityEvidence: EVIDENCE_JULY10,
      selectedSlot: matchingSlot,
      selectedSlotProof: SLOT_PROOF_JULY10,
    }),
    false,
  );
});

test("BSDT-5-unit: shouldInterceptInvalidSlotDateTime — date+time match → false (allowed)", () => {
  // Current-turn avail has slot on 2026-07-10 at 12:00; request matches exactly.
  assert.equal(
    shouldInterceptInvalidSlotDateTime({
      pendingToolRequests: [BOOKING_CORRECT_DATE],
      currentAvailabilityAttempt: SUCCESS_ATTEMPT_JULY10,
      activeAvailabilityEvidence: EVIDENCE_JULY10,
      selectedSlot: null,
      selectedSlotProof: null,
    }),
    false,
  );
});

// ── Integration: date mismatch blocks booking ─────────────────────────────────

test("BSDT-1: avail.check returns 2026-07-10T12:00, booking.apply requests 2026-07-11 12:00 → blocked, executor not called", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    // Pin "now" to 11:00 Prague (09:00 UTC) so the 2026-07-10 12:00 slot is in the future.
    now: new Date("2026-07-10T09:00:00.000Z"),
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bsdt1",
        tool_requests: [AVAILABILITY_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_bsdt1",
        tool_requests: [BOOKING_WRONG_DATE],
      },
      {
        type: "final_response",
        conversation_id: "conv_bsdt1",
        final_response: { final_patient_reply: "Это время недоступно. Выберите из доступных слотов." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: {
          slots: [{ starts_at: "2026-07-10T12:00:00", ends_at: "2026-07-10T12:30:00" }],
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
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bsdt1",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called on date mismatch");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "invalid_slot",
    "booking_status must be invalid_slot on date mismatch",
  );
  assert.equal((bookingResult!.data as Record<string, unknown>).created_visit, false);
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_invalid_slot_round2",
  );
});

// ── Integration: date+time match allows booking to proceed ────────────────────

test("BSDT-2: avail.check returns 2026-07-10T12:00, booking.apply requests 2026-07-10 12:00 → executor called", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    // Pin "now" to 11:00 Prague (09:00 UTC) so the 12:00 slot is 1 h in the future.
    now: new Date("2026-07-10T09:00:00.000Z"),
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bsdt2",
        tool_requests: [AVAILABILITY_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_bsdt2",
        tool_requests: [BOOKING_CORRECT_DATE],
      },
      {
        type: "final_response",
        conversation_id: "conv_bsdt2",
        final_response: { final_patient_reply: "Запись создана на 10 июля в 12:00." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: {
          slots: [{ starts_at: "2026-07-10T12:00:00", ends_at: "2026-07-10T12:30:00" }],
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
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bsdt2",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingExecutorCalled, true, "booking.apply executor MUST be called when date+time match");
  assert.ok(result.final_patient_reply.length > 0, "must have a final reply");
});

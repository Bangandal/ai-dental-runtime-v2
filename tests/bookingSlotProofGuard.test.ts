/**
 * PR #163 — booking.apply requires selected_slot proof.
 *
 * Guard G: booking.apply may proceed only when there is verified slot proof —
 * either a successful availability.check result in the current turn whose slots
 * cover the requested date+time, or a selected_slot from booking process state
 * that matches. Without proof, booking.apply is blocked with
 * booking_status: "slot_not_verified" before reaching the ClinicCard executor.
 *
 * 5 unit tests (shouldInterceptMissingSlotProof) + 3 integration tests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { shouldInterceptMissingSlotProof } from "../src/runtime/bookingApplyPreflight.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";
import type { AvailableSlot } from "../src/runtime/bookingProcessState.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

const SLOT: AvailableSlot = {
  starts_at: "2026-07-09T12:00:00",
  ends_at: "2026-07-09T12:30:00",
  slot_id: "2026-07-09T12:00",
};

const BOOKING_APPLY_FULL: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_1",
  arguments: {
    first_name: "Роман",
    last_name: "Анбасадоров",
    service: "чистка",
    requested_date: "2026-07-09",
    requested_time: "12:00",
  },
};

const AVAILABILITY_SUCCESS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_av_1",
  status: "success",
  data: { slots: [{ starts_at: "2026-07-09T12:00:00", ends_at: "2026-07-09T12:30:00" }], total_slots: 1, free_slots_count: 1 },
};

const AVAILABILITY_FAILED: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_av_2",
  status: "failed",
  error: { code: "adapter_error", message: "timeout" },
};

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  user_message: "Да, запишите меня",
  locale: "ru",
  trace_id: "trace_pr163",
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

// ── Unit: shouldInterceptMissingSlotProof ─────────────────────────────────────

test("BSPG-1: intercepts when no avail.check in results and no selectedSlot", () => {
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      completedToolResults: [],
      selectedSlot: null,
    }),
    true,
  );
});

test("BSPG-2: does NOT intercept when successful avail.check result is present (shouldInterceptInvalidSlotTime handles mismatch)", () => {
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      completedToolResults: [AVAILABILITY_SUCCESS],
      selectedSlot: null,
    }),
    false,
  );
});

test("BSPG-3: does NOT intercept when no avail.check but selectedSlot matches requested date+time", () => {
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      completedToolResults: [],
      selectedSlot: SLOT,
    }),
    false,
  );
});

test("BSPG-4: intercepts when selectedSlot date mismatches requested_date", () => {
  const wrongDateSlot: AvailableSlot = { starts_at: "2026-07-10T12:00:00" }; // different date
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      completedToolResults: [],
      selectedSlot: wrongDateSlot,
    }),
    true,
  );
});

test("BSPG-5: intercepts when selectedSlot time mismatches requested_time", () => {
  const wrongTimeSlot: AvailableSlot = { starts_at: "2026-07-09T14:00:00" }; // different time
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      completedToolResults: [],
      selectedSlot: wrongTimeSlot,
    }),
    true,
  );
});

// ── Integration: round-2, no avail.check → slot_not_verified ─────────────────

test("BSPG-6: round-2 booking.apply with no avail.check result → slot_not_verified, executor not called", async () => {
  let bookingExecutorCalled = false;

  // Sequence: round-1 model requests kb.search (not avail.check), then round-2 requests
  // booking.apply directly — no avail.check was done in this turn.
  const KB_REQUEST: RuntimeAgentToolRequest = {
    tool: "kb.search" as any,
    call_id: "call_kb_1",
    arguments: { query: "цена чистки" },
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bspg6",
        tool_requests: [KB_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_bspg6",
        tool_requests: [BOOKING_APPLY_FULL],
      },
      {
        type: "final_response",
        conversation_id: "conv_bspg6",
        final_response: { final_patient_reply: "Сначала проверим доступное время — на какую дату удобно?" },
      },
    ]),
    executors: {
      "kb.search": async () => ({
        status: "success" as const,
        data: { chunks: [{ text: "Чистка — 1500 Kč" }] },
      }),
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bspg6",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called without slot proof");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "slot_not_verified",
    "booking_status must be slot_not_verified",
  );
  assert.equal((bookingResult!.data as Record<string, unknown>).created_visit, false);
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_slot_proof_round2",
  );
});

// ── Integration: round-1, no selectedSlot → slot_not_verified ────────────────

test("BSPG-7: round-1 booking.apply with all fields but no slot proof → slot_not_verified, executor not called", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bspg7",
        tool_requests: [BOOKING_APPLY_FULL],
      },
      {
        type: "final_response",
        conversation_id: "conv_bspg7",
        final_response: { final_patient_reply: "Давайте сначала проверим доступные слоты." },
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
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bspg7",
    channel_contact: TRUSTED_CONTACT,
    // No bookingProcessStateRepository → no selectedSlot from prior state
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called without slot proof");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "slot_not_verified",
    "booking_status must be slot_not_verified",
  );
  assert.equal((bookingResult!.data as Record<string, unknown>).created_visit, false);
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_slot_proof_round1",
  );
});

// ── Integration: phone guard has priority over slot proof guard ───────────────

test("BSPG-8: phone guard fires before slot proof guard — missing phone + no avail.check → missing_trusted_phone, not slot_not_verified", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bspg8",
        tool_requests: [BOOKING_APPLY_FULL],
      },
      {
        type: "final_response",
        conversation_id: "conv_bspg8",
        final_response: { final_patient_reply: "Нажмите кнопку для отправки номера телефона." },
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
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bspg8",
    channel_contact: undefined, // no phone
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "missing_trusted_phone",
    "phone guard must fire before slot proof guard",
  );
  assert.notEqual(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "slot_not_verified",
    "slot_not_verified must NOT fire when phone guard already blocked",
  );
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_trusted_phone_round1",
  );
});

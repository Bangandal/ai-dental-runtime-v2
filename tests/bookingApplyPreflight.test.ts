/**
 * PR #141 — bookingApplyPreflight tests.
 *
 * Test 1 (no-slots preflight): availability.check returns 0 slots + trusted phone +
 * model requests booking.apply in round 2 → booking.apply executor NOT called,
 * reply says no slots, conversation dirty.
 *
 * Test 2 (missing trusted phone with valid slot): availability.check returns ≥1 slot +
 * no trusted phone + model requests booking.apply in round 2 → Guard A fires,
 * contact button returned, booking.apply executor NOT called.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAvailabilitySuccessWithNoSlots,
  shouldInterceptMissingPhoneBeforeBookingApply,
  shouldInterceptNoSlotsBeforeBookingApply,
  buildNoSlotsPreflightReply,
} from "../src/runtime/bookingApplyPreflight.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SLOT = { slot_id: "2026-07-09T12:00", starts_at: "2026-07-09T12:00:00", ends_at: "2026-07-09T12:30:00" };

const AVAILABILITY_SUCCESS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_1",
  status: "success",
  data: { slots: [SLOT], total_slots: 1, free_slots_count: 1 },
};

const AVAILABILITY_EMPTY: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_2",
  status: "success",
  data: { slots: [], total_slots: 0, free_slots_count: 0 },
};

const AVAILABILITY_FAILED: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_3",
  status: "failed",
  error: { code: "adapter_error", message: "timeout" },
};

const BOOKING_APPLY_REQUEST: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_book_1",
  arguments: {
    service: "chistka",
    requested_date: "2026-07-09",
    requested_time: "12:00",
    first_name: "Роман",
    last_name: "Ансамблев",
  },
};

const AVAILABILITY_REQUEST: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_req_1",
  arguments: { service_interest: "chistka", requested_date: "2026-07-09" },
};

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  conversation_id: "conv_141_test",
  user_message: "Запишите меня",
  locale: "ru",
  trace_id: "trace_pr141",
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

// ── Unit: hasAvailabilitySuccessWithNoSlots ───────────────────────────────────

test("hasAvailabilitySuccessWithNoSlots: true when slots array is empty", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([AVAILABILITY_EMPTY]), true);
});

test("hasAvailabilitySuccessWithNoSlots: false when slots present", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([AVAILABILITY_SUCCESS]), false);
});

test("hasAvailabilitySuccessWithNoSlots: false when availability.check failed", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([AVAILABILITY_FAILED]), false);
});

test("hasAvailabilitySuccessWithNoSlots: false for empty results list", () => {
  assert.equal(hasAvailabilitySuccessWithNoSlots([]), false);
});

// ── Unit: shouldInterceptMissingPhoneBeforeBookingApply ───────────────────────

test("shouldInterceptMissingPhoneBeforeBookingApply: true when booking.apply pending and no phone", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      channelContact: undefined,
    }),
    true,
  );
});

test("shouldInterceptMissingPhoneBeforeBookingApply: true when phone_source is untrusted (manual_input)", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      channelContact: { phone_number: "+1", phone_source: "manual_input" },
    }),
    true,
  );
});

test("shouldInterceptMissingPhoneBeforeBookingApply: false when trusted phone present", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      channelContact: TRUSTED_CONTACT,
    }),
    false,
  );
});

test("shouldInterceptMissingPhoneBeforeBookingApply: false when no booking.apply pending", () => {
  assert.equal(
    shouldInterceptMissingPhoneBeforeBookingApply({
      pendingToolRequests: [AVAILABILITY_REQUEST],
      channelContact: undefined,
    }),
    false,
  );
});

// ── Unit: shouldInterceptNoSlotsBeforeBookingApply ────────────────────────────

test("shouldInterceptNoSlotsBeforeBookingApply: true when booking.apply pending + trusted phone + 0 slots", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_EMPTY],
      channelContact: TRUSTED_CONTACT,
    }),
    true,
  );
});

test("shouldInterceptNoSlotsBeforeBookingApply: false when slots present", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_SUCCESS],
      channelContact: TRUSTED_CONTACT,
    }),
    false,
  );
});

test("shouldInterceptNoSlotsBeforeBookingApply: false when no trusted phone (Guard A handles it)", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_EMPTY],
      channelContact: undefined,
    }),
    false,
  );
});

test("shouldInterceptNoSlotsBeforeBookingApply: false when no booking.apply pending", () => {
  assert.equal(
    shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: [AVAILABILITY_REQUEST],
      completedToolResults: [AVAILABILITY_EMPTY],
      channelContact: TRUSTED_CONTACT,
    }),
    false,
  );
});

// ── Unit: buildNoSlotsPreflightReply ─────────────────────────────────────────

test("buildNoSlotsPreflightReply: RU locale contains slot/slots keyword", () => {
  const reply = buildNoSlotsPreflightReply("ru");
  assert.ok(reply.length > 0);
  assert.ok(reply.includes("слот"), `RU reply should mention slots: ${reply}`);
});

test("buildNoSlotsPreflightReply: CS locale", () => {
  const reply = buildNoSlotsPreflightReply("cs");
  assert.ok(reply.includes("slot"), `CS reply should mention slot: ${reply}`);
});

test("buildNoSlotsPreflightReply: EN locale", () => {
  const reply = buildNoSlotsPreflightReply("en");
  assert.ok(reply.includes("slot"), `EN reply should mention slot: ${reply}`);
});

test("buildNoSlotsPreflightReply: defaults to RU for null locale", () => {
  const reply = buildNoSlotsPreflightReply(null);
  assert.ok(reply.includes("слот"));
});

// ── Integration Test 1: No-slots preflight ───────────────────────────────────
// availability.check returns 0 slots + trusted phone + model requests booking.apply
// → no-slots gate fires, booking.apply executor NOT called

test("runtimeAgentLoop: no-slots preflight — booking.apply not executed when 0 slots returned", async () => {
  let bookingApplyExecutorCalled = false;

  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_141_1",
      tool_requests: [AVAILABILITY_REQUEST],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_141_1",
      tool_requests: [BOOKING_APPLY_REQUEST],
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [], total_slots: 0, free_slots_count: 0 },
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return {
          status: "success" as const,
          data: {
            booking_action: "booking_apply",
            booking_status: "booking_write_disabled",
            created_visit: false,
            may_claim_booked: false,
          },
        };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_141_1",
    channel_contact: TRUSTED_CONTACT,
  });

  // booking.apply executor must NOT have been called
  assert.equal(bookingApplyExecutorCalled, false, "booking.apply executor must not be called when 0 slots");

  // No booking_write_disabled in tool_results
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.equal(bookingResult, undefined, "booking.apply must not appear in tool_results");

  // Reply must mention no slots
  assert.ok(
    result.final_patient_reply.toLowerCase().includes("слот") ||
      result.final_patient_reply.toLowerCase().includes("slot"),
    `Reply must mention no slots: ${result.final_patient_reply}`,
  );

  // created_visit and may_claim_booked implied false — no booking result present
  // Conversation must be dirty / not resumable
  assert.equal(result.conversation_id, null, "conversation_id must be null (dirty)");
  assert.equal(result.conversation_id_resumable, false, "must not be resumable");

  // debug.reason identifies the no-slots intercept
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_no_slots",
    "debug.reason must identify no-slots preflight",
  );
});

// ── Integration Test 2: Missing trusted phone with valid slot ─────────────────
// availability.check returns ≥1 slot + no trusted phone + model requests booking.apply
// → Guard A fires (contact button), booking.apply NOT executed

test("runtimeAgentLoop: Guard A fires when booking.apply pending and phone absent (valid slot present)", async () => {
  let bookingApplyExecutorCalled = false;

  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_141_2",
      tool_requests: [AVAILABILITY_REQUEST],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_141_2",
      tool_requests: [BOOKING_APPLY_REQUEST],
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [SLOT], total_slots: 1, free_slots_count: 1 },
      }),
      "booking.apply": async () => {
        bookingApplyExecutorCalled = true;
        return {
          status: "success" as const,
          data: {
            booking_action: "booking_apply",
            booking_status: "visit_created",
            created_visit: true,
            may_claim_booked: true,
            cliniccard_visit_id: "visit_999",
            cliniccard_patient_id: "patient_999",
            phone_source: "telegram_contact_button",
          },
        };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_141_2",
    channel_contact: undefined,
  });

  // booking.apply executor must NOT have been called
  assert.equal(bookingApplyExecutorCalled, false, "booking.apply executor must not be called when phone absent");

  // Contact button must be returned
  assert.equal(result.ui?.telegram?.request_contact, true, "ui.telegram.request_contact must be true");
  assert.ok(result.final_patient_reply.includes("телефон"), "reply must ask for phone number");

  // No ClinicCard write
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.equal(bookingResult, undefined, "booking.apply must not appear in tool_results");

  // Conversation dirty
  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);

  // debug.reason must identify Guard A intercept
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_intercepted_missing_trusted_phone",
  );
});

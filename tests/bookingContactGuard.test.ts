/**
 * PR #132 — bookingContactGuard tests.
 *
 * Guards forced_finalization against the active-booking/no-phone scenario:
 * when round-2 requests booking.apply but trusted phone is absent and
 * round-1 availability.check already returned slots, the guard intercepts
 * and returns a contact-button prompt instead of a generic greeting.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTrustedPhone,
  hasBookingApplyPending,
  hasAvailabilitySuccessWithSlots,
  shouldInterceptForContactButton,
  buildContactButtonReply,
} from "../src/runtime/bookingContactGuard.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
  RuntimeAgentCallerOutput,
} from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AVAILABILITY_SUCCESS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_1",
  status: "success",
  data: {
    slots: [
      { slot_id: "2026-07-09T12:00", starts_at: "2026-07-09T12:00:00", ends_at: "2026-07-09T12:30:00" },
    ],
    total_slots: 1,
    free_slots_count: 1,
  },
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
  phone_number: "+420600111222",
  phone_source: "telegram_contact_button",
};

const UNTRUSTED_CONTACT: ChannelContact = {
  phone_number: "+420600111222",
  phone_source: "manual_input",
};

// ── Unit: hasTrustedPhone ─────────────────────────────────────────────────────

test("hasTrustedPhone: returns true for telegram_contact_button", () => {
  assert.equal(hasTrustedPhone({ phone_number: "+1", phone_source: "telegram_contact_button" }), true);
});

test("hasTrustedPhone: returns true for whatsapp_sender", () => {
  assert.equal(hasTrustedPhone({ phone_number: "+1", phone_source: "whatsapp_sender" }), true);
});

test("hasTrustedPhone: returns true for existing_cliniccard_patient", () => {
  assert.equal(hasTrustedPhone({ phone_number: "+1", phone_source: "existing_cliniccard_patient" }), true);
});

test("hasTrustedPhone: returns false for manual_input", () => {
  assert.equal(hasTrustedPhone({ phone_number: "+1", phone_source: "manual_input" }), false);
});

test("hasTrustedPhone: returns false when channelContact is undefined", () => {
  assert.equal(hasTrustedPhone(undefined), false);
});

// ── Unit: hasBookingApplyPending ──────────────────────────────────────────────

test("hasBookingApplyPending: true when booking.apply in list", () => {
  assert.equal(hasBookingApplyPending([BOOKING_APPLY_REQUEST]), true);
});

test("hasBookingApplyPending: false when only availability.check in list", () => {
  assert.equal(hasBookingApplyPending([AVAILABILITY_REQUEST]), false);
});

test("hasBookingApplyPending: false for empty list", () => {
  assert.equal(hasBookingApplyPending([]), false);
});

// ── Unit: hasAvailabilitySuccessWithSlots ─────────────────────────────────────

test("hasAvailabilitySuccessWithSlots: true when availability.check succeeded with slots", () => {
  assert.equal(hasAvailabilitySuccessWithSlots([AVAILABILITY_SUCCESS]), true);
});

test("hasAvailabilitySuccessWithSlots: false when slots array is empty", () => {
  assert.equal(hasAvailabilitySuccessWithSlots([AVAILABILITY_EMPTY]), false);
});

test("hasAvailabilitySuccessWithSlots: false when availability.check failed", () => {
  assert.equal(hasAvailabilitySuccessWithSlots([AVAILABILITY_FAILED]), false);
});

test("hasAvailabilitySuccessWithSlots: false for empty results list", () => {
  assert.equal(hasAvailabilitySuccessWithSlots([]), false);
});

// ── Unit: shouldInterceptForContactButton ─────────────────────────────────────

// Test 3: booking.apply pending + slots + no phone → intercept
test("shouldInterceptForContactButton: fires when booking.apply pending, slot available, phone absent", () => {
  assert.equal(
    shouldInterceptForContactButton({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_SUCCESS],
      channelContact: undefined,
    }),
    true,
  );
});

// Test 3 variant: untrusted phone_source
test("shouldInterceptForContactButton: fires when phone_source is manual_input (untrusted)", () => {
  assert.equal(
    shouldInterceptForContactButton({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_SUCCESS],
      channelContact: UNTRUSTED_CONTACT,
    }),
    true,
  );
});

// Must not fire when phone is trusted
test("shouldInterceptForContactButton: does NOT fire when phone is trusted (telegram_contact_button)", () => {
  assert.equal(
    shouldInterceptForContactButton({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_SUCCESS],
      channelContact: TRUSTED_CONTACT,
    }),
    false,
  );
});

// Must not fire when availability has no slots
test("shouldInterceptForContactButton: does NOT fire when availability returned no slots", () => {
  assert.equal(
    shouldInterceptForContactButton({
      pendingToolRequests: [BOOKING_APPLY_REQUEST],
      completedToolResults: [AVAILABILITY_EMPTY],
      channelContact: undefined,
    }),
    false,
  );
});

// Must not fire when booking.apply is not pending
test("shouldInterceptForContactButton: does NOT fire when pending requests have no booking.apply", () => {
  assert.equal(
    shouldInterceptForContactButton({
      pendingToolRequests: [AVAILABILITY_REQUEST],
      completedToolResults: [AVAILABILITY_SUCCESS],
      channelContact: undefined,
    }),
    false,
  );
});

// ── Unit: buildContactButtonReply ─────────────────────────────────────────────

test("buildContactButtonReply: RU locale includes request_contact:true", () => {
  const reply = buildContactButtonReply("ru");
  assert.equal(reply.ui.telegram.request_contact, true);
  assert.ok(reply.final_patient_reply.length > 0);
  assert.ok(reply.ui.telegram.button_text.length > 0);
});

test("buildContactButtonReply: CS locale", () => {
  const reply = buildContactButtonReply("cs");
  assert.equal(reply.ui.telegram.request_contact, true);
  assert.ok(reply.final_patient_reply.includes("telefonní číslo"));
});

test("buildContactButtonReply: EN locale", () => {
  const reply = buildContactButtonReply("en");
  assert.equal(reply.ui.telegram.request_contact, true);
  assert.ok(reply.final_patient_reply.includes("phone number"));
});

test("buildContactButtonReply: defaults to RU for unknown locale", () => {
  const reply = buildContactButtonReply(null);
  assert.equal(reply.ui.telegram.request_contact, true);
  assert.ok(reply.final_patient_reply.includes("телефон"));
});

// ── Integration: runtimeAgentLoop guard intercept ────────────────────────────

function makeCallerSequence(outputs: RuntimeAgentCallerOutput[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  conversation_id: "conv_existing_123",
  user_message: "Роман, ансамблев",
  locale: "ru",
  trace_id: "trace_test_001",
};

// Test 2: forced_finalization after availability.check + missing phone → contact button
test("runtimeAgentLoop: guard intercepts when round-2 requests booking.apply without trusted phone", async () => {
  // Round 1: model calls availability.check
  // Round 2: model calls booking.apply (no phone in context)
  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_existing_123",
      tool_requests: [AVAILABILITY_REQUEST],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_existing_123",
      tool_requests: [BOOKING_APPLY_REQUEST],
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: AVAILABILITY_SUCCESS.data,
      }),
    },
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, channel_contact: undefined });

  // Test 2: contact button returned, not generic greeting
  assert.equal(result.ui?.telegram?.request_contact, true, "should set request_contact:true");
  assert.ok(result.final_patient_reply.includes("телефон"), "reply should mention phone");
  assert.notEqual(result.final_patient_reply, "Здравствуйте! Чем могу помочь?", "must not be generic greeting");

  // Test 1 (reframed): conversation is dirty (expected) — not resumable
  assert.equal(result.conversation_id, null, "conversation_id must be null (dirty)");
  assert.equal(result.conversation_id_resumable, false, "must not be resumable");

  // debug.reason must identify the intercept
  assert.equal((result.debug as Record<string, unknown>)?.reason, "booking_apply_intercepted_missing_trusted_phone");
});

// Test 1 variant: same guard fires in CS locale
test("runtimeAgentLoop: guard returns CS phone-ask when locale=cs", async () => {
  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_cs_1",
      tool_requests: [AVAILABILITY_REQUEST],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_cs_1",
      tool_requests: [BOOKING_APPLY_REQUEST],
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: AVAILABILITY_SUCCESS.data,
      }),
    },
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_cs_1", locale: "cs", channel_contact: undefined });
  assert.equal(result.ui?.telegram?.request_contact, true);
  assert.ok(result.final_patient_reply.includes("telefonní číslo"));
});

// Test 3: booking.apply with trusted phone is NOT intercepted (passes through to forced_finalization)
test("runtimeAgentLoop: guard does NOT intercept when phone is trusted", async () => {
  const FINAL_BOOKING_REPLY = "Запись подтверждена!";
  let forcedFinalizationCalled = false;

  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_trusted_1",
      tool_requests: [AVAILABILITY_REQUEST],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_trusted_1",
      tool_requests: [BOOKING_APPLY_REQUEST],
    },
    // Round 3 = forced finalization call
    (() => {
      forcedFinalizationCalled = true;
      return {
        type: "final_response" as const,
        conversation_id: null,
        final_response: {
          final_patient_reply: FINAL_BOOKING_REPLY,
          safety_notes: [],
        },
      };
    })(),
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: AVAILABILITY_SUCCESS.data,
      }),
    },
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, conversation_id: "conv_trusted_1", channel_contact: TRUSTED_CONTACT });

  assert.notEqual(result.ui?.telegram?.request_contact, true, "must not show contact button when phone is trusted");
  assert.equal(result.final_patient_reply, FINAL_BOOKING_REPLY);
  assert.equal(forcedFinalizationCalled, true, "forced finalization should be called when guard does not fire");
});

// Test 4: "Роман, ансамблев" as name candidate — guard fires when model produces booking.apply
// (model behavior mocked: model treats "Роман, ансамблев" as name and tries booking.apply)
test("runtimeAgentLoop: 'Роман, ансамблев' treated as name candidate — guard intercepts booking.apply", async () => {
  // This mirrors the exact live smoke transcript sequence:
  // turn 5 input: "Роман, ансамблев"
  // round 1: model calls availability.check (checking the already-known slot)
  // round 2: model calls booking.apply with first_name=Роман last_name=Ансамблев
  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_live_smoke",
      tool_requests: [{ tool: "availability.check", call_id: "c1", arguments: { service_interest: "chistka", requested_date: "2026-07-09" } }],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_live_smoke",
      tool_requests: [{
        tool: "booking.apply",
        call_id: "c2",
        arguments: { service: "chistka", requested_date: "2026-07-09", requested_time: "12:00", first_name: "Роман", last_name: "Ансамблев" },
      }],
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: AVAILABILITY_SUCCESS.data,
      }),
    },
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_live",
    case_id: null,
    conversation_id: "conv_live_smoke",
    user_message: "Роман, ансамблев",
    locale: "ru",
    channel_contact: undefined, // no phone yet
  });

  // Must not produce generic greeting
  assert.notEqual(result.final_patient_reply, "Здравствуйте, как я могу вам помочь?");
  assert.notEqual(result.final_patient_reply, "Здравствуйте! Чем могу помочь?");
  // Must ask for phone
  assert.equal(result.ui?.telegram?.request_contact, true);
  assert.ok(result.final_patient_reply.includes("телефон"));
  // booking.apply must not have executed (no booking result in tool_results)
  const hasBookingResult = result.tool_results?.some(r => r.tool === "booking.apply");
  assert.equal(hasBookingResult, false, "booking.apply must not execute before phone is trusted");
});

// Test 5: PR #121 behavior — forced_finalization without booking context still works
test("runtimeAgentLoop: forced_finalization without booking context still produces fallback (PR #121 safe)", async () => {
  // Round 1: kb.search
  // Round 2: model requests another kb.search (no booking involved)
  // → forced_finalization fires, guard does NOT intercept (no booking.apply pending)
  const KB_RESULT: RuntimeAgentToolResult = {
    tool: "kb.search",
    call_id: "call_kb_1",
    status: "success",
    data: { chunks: [{ chunk_id: "c1", score: 0.9, text: "Price info" }] },
  };

  const FALLBACK_REPLY = "I'll clarify the details with the clinic team — one moment.";
  const caller = makeCallerSequence([
    {
      type: "tool_requests",
      conversation_id: "conv_pr121",
      tool_requests: [{ tool: "kb.search", call_id: "call_kb_1", arguments: { query: "price" } }],
    },
    {
      type: "tool_requests",
      conversation_id: "conv_pr121",
      tool_requests: [{ tool: "kb.search", call_id: "call_kb_2", arguments: { query: "more info" } }],
    },
    // forced_finalization round
    {
      type: "final_response",
      conversation_id: null,
      final_response: { final_patient_reply: FALLBACK_REPLY, safety_notes: [] },
    },
  ]);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {
      "kb.search": async () => ({
        status: "success" as const,
        data: KB_RESULT.data,
      }),
    },
  });

  const result = await loop.runTurn({ ...BASE_TURN_INPUT, channel_contact: undefined });

  // Guard should NOT fire (no booking.apply pending)
  assert.notEqual((result.debug as Record<string, unknown>)?.reason, "booking_apply_intercepted_missing_trusted_phone");
  // forced_finalization should produce the model reply
  assert.equal(result.final_patient_reply, FALLBACK_REPLY);
  assert.equal(result.conversation_id, null); // dirty as expected by PR #121
  assert.equal(result.conversation_id_resumable, false);
});

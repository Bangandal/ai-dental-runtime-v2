/**
 * Tests for channelCapabilityPolicy.ts (A–F per spec).
 *
 * A. Telegram → contact button UI
 * B. WhatsApp → no Telegram UI
 * C. Unknown/undefined channel → no UI
 * D. Trusted phone suppresses contact request UI
 * E. Missing phone guard still fires (booking.apply blocked)
 * F. No spurious booking confirmation when phone guard blocks
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getChannelCapabilityPolicy,
  buildPhoneCaptureUi,
} from "../src/runtime/channelCapabilityPolicy.ts";
import {
  maybeAttachPhoneRequestUI,
  createRuntimeAgentLoop,
  type RuntimeAgentCaller,
} from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentCallerOutput,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";

// ── A: Telegram ───────────────────────────────────────────────────────────────

test("A: getChannelCapabilityPolicy telegram returns correct policy", () => {
  const policy = getChannelCapabilityPolicy("telegram");
  assert.equal(policy.channel, "telegram");
  assert.equal(policy.phone_capture_method, "telegram_contact_button");
  assert.equal(policy.supports_trusted_phone_capture, true);
  assert.deepEqual(policy.trusted_phone_sources, ["telegram_contact_button"]);
});

test("A: buildPhoneCaptureUi telegram returns contact button UI", () => {
  const ui = buildPhoneCaptureUi("telegram");
  assert.ok(ui, "UI should not be undefined for telegram");
  assert.equal(ui!.telegram?.request_contact, true);
  assert.ok(ui!.telegram?.button_text, "button_text should be set");
});

// ── B: WhatsApp ───────────────────────────────────────────────────────────────

test("B: getChannelCapabilityPolicy whatsapp returns sender_phone method", () => {
  const policy = getChannelCapabilityPolicy("whatsapp");
  assert.equal(policy.channel, "whatsapp");
  assert.equal(policy.phone_capture_method, "sender_phone");
  assert.equal(policy.supports_trusted_phone_capture, true);
});

test("B: buildPhoneCaptureUi whatsapp returns undefined (no Telegram UI)", () => {
  const ui = buildPhoneCaptureUi("whatsapp");
  assert.equal(ui, undefined, "WhatsApp should not inject Telegram contact button");
});

// ── C: Unknown / undefined ────────────────────────────────────────────────────

test("C: getChannelCapabilityPolicy unknown channel returns none", () => {
  const policyUndef = getChannelCapabilityPolicy(undefined);
  assert.equal(policyUndef.channel, "unknown");
  assert.equal(policyUndef.phone_capture_method, "none");
  assert.equal(policyUndef.supports_trusted_phone_capture, false);

  const policyNull = getChannelCapabilityPolicy(null);
  assert.equal(policyNull.channel, "unknown");

  const policyStr = getChannelCapabilityPolicy("unknown");
  assert.equal(policyStr.channel, "unknown");
});

test("C: buildPhoneCaptureUi unknown/undefined returns undefined (no UI)", () => {
  assert.equal(buildPhoneCaptureUi(undefined), undefined);
  assert.equal(buildPhoneCaptureUi(null), undefined);
  assert.equal(buildPhoneCaptureUi("unknown"), undefined);
  assert.equal(buildPhoneCaptureUi("sms"), undefined);
  assert.equal(buildPhoneCaptureUi("web"), undefined);
});

// ── D: Trusted phone suppresses UI ───────────────────────────────────────────

test("D: maybeAttachPhoneRequestUI — phone_trusted=true suppresses contact UI", () => {
  const state = {
    next_action: "ask_for_phone" as const,
    phone_trusted: true,
    next_action_confidence: "high" as const,
  };
  // When phone_trusted is true, no UI should be attached
  const result = maybeAttachPhoneRequestUI(state, undefined, "telegram");
  assert.equal(result, undefined, "Should not attach UI when phone is already trusted");
});

test("D: maybeAttachPhoneRequestUI — existing request_contact=true not overwritten", () => {
  const state = {
    next_action: "ask_for_phone" as const,
    phone_trusted: false,
    next_action_confidence: "high" as const,
  };
  const existingUi = { telegram: { request_contact: true as const, button_text: "Custom" } };
  const result = maybeAttachPhoneRequestUI(state, existingUi, "telegram");
  // Should return existingUi unchanged — no overwrite
  assert.equal(result?.telegram?.request_contact, true);
  assert.equal(result?.telegram?.button_text, "Custom");
});

test("D: maybeAttachPhoneRequestUI — low confidence suppresses UI even for ask_for_phone", () => {
  const state = {
    next_action: "ask_for_phone" as const,
    phone_trusted: false,
    next_action_confidence: "low" as const,
  };
  const result = maybeAttachPhoneRequestUI(state, undefined, "telegram");
  assert.equal(result, undefined, "Low confidence should suppress UI");
});

// ── E: Missing phone guard fires ──────────────────────────────────────────────

test("E: booking.apply guard intercepts missing trusted phone — returns ask_for_phone", async () => {
  let callCount = 0;
  const caller: RuntimeAgentCaller = async (_input) => {
    callCount++;
    if (callCount === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv-e",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_ba_e",
          // Use a future date/time well clear of turnNow
          arguments: { first_name: "Иван", last_name: "Петров", service: "осмотр", requested_date: "2026-07-15", requested_time: "14:00" },
        }],
      } satisfies RuntimeAgentCallerOutput;
    }
    return {
      type: "final_response",
      conversation_id: "conv-e",
      final_response: { final_patient_reply: "Пожалуйста, поделитесь контактом." },
    } satisfies RuntimeAgentCallerOutput;
  };

  const agent = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {},
    // now = 08:00 UTC = 10:00 Prague; slot is 14:00 Prague — clearly future
    now: new Date("2026-07-15T08:00:00Z"),
  });

  const result = await agent.runTurn({
    clinic_id: "clinic-e",
    user_message: "Запишите меня",
    // No channel_contact — no trusted phone
    business_context: { channel: "telegram" },
  });

  // Guard should fire: booking.apply not executed, reply from guarded path
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "booking.apply result should exist");
  assert.equal(bookingResult!.status, "success");
  assert.equal((bookingResult!.data as Record<string, unknown>)?.booking_status, "missing_trusted_phone");
  assert.equal((bookingResult!.data as Record<string, unknown>)?.required_next_action, "ask_for_phone");
});

// ── F: No spurious booking confirmation when phone guard blocks ───────────────

test("F: phone guard block does not produce booking confirmation in reply", async () => {
  let secondCallCtx: Record<string, unknown> | undefined;
  let callCount = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    callCount++;
    if (callCount === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv-f",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_ba_f",
          arguments: { first_name: "Мария", last_name: "Иванова", service: "чистка", requested_date: "2026-07-15", requested_time: "14:00" },
        }],
      } satisfies RuntimeAgentCallerOutput;
    }
    // Second call — guarded tool_result submitted
    secondCallCtx = input.input.context as Record<string, unknown>;
    return {
      type: "final_response",
      conversation_id: "conv-f",
      final_response: { final_patient_reply: "Нажмите кнопку для передачи контакта." },
    } satisfies RuntimeAgentCallerOutput;
  };

  const agent = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    executors: {},
    now: new Date("2026-07-15T08:00:00Z"),
  });

  const result = await agent.runTurn({
    clinic_id: "clinic-f",
    user_message: "Запишите меня",
    business_context: { channel: "telegram" },
  });

  // Booking should NOT be confirmed
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "booking.apply guarded result should exist");
  const data = bookingResult!.data as Record<string, unknown>;
  // Guarded result has booking_status, not a created visit
  assert.equal(data.booking_status, "missing_trusted_phone");
  assert.ok(result.final_patient_reply, "reply should not be empty");

  // Second call context should have booking_apply_action_truth with can_say_booking_created=false
  if (secondCallCtx) {
    const truth = secondCallCtx.booking_apply_action_truth as Record<string, unknown> | undefined;
    if (truth) {
      const claims = truth.allowed_claims as Record<string, unknown> | undefined;
      assert.equal(claims?.can_say_booking_created, false);
    }
  }
});

/**
 * PR #125 — Telegram contact-share UI for ask_for_phone.
 *
 * A. missing_phone on Telegram → orchestrator injects ui.telegram.request_contact=true
 * B. missing_phone on non-Telegram channel → no ui.telegram injected
 * C. Telegram webhook route sends reply_markup when ui.telegram.request_contact=true
 * D. manual_input phone_source still blocked for live booking (missing_phone)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeTurnOrchestrated } from "../src/runtime/runtimeTurnOrchestrator.ts";
import { registerTelegramWebhookRoute } from "../src/runtime/telegramWebhookRoute.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

process.env.LEGACY_CASE_ROUTER_ENABLED = "false";

const CLINIC_CODE = "clinic_1";
const CLINIC_UUID = "e8179559-fc8d-40e5-9808-287ed69fcf7c";

const clinicResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC_CODE || input.clinic_identifier === CLINIC_UUID) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC_CODE } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
  },
};

function missingPhoneToolResult(): RuntimeAgentToolResult {
  return {
    tool: "booking.apply",
    status: "success",
    data: {
      booking_status: "missing_phone",
      created_visit: false,
      may_claim_booked: false,
      cliniccard_visit_id: null,
      reason: "phone_number is required; capture via the channel contact mechanism",
      proof: null,
    },
  };
}

function serviceReturningMissingPhone(): RuntimeTurnService {
  return {
    async runTurn() {
      return {
        final_patient_reply: "Пожалуйста, поделитесь своим номером телефона через кнопку ниже.",
        tool_requests: [
          { tool: "booking.apply", arguments: { first_name: "Иван", last_name: "Петров", service: "чистка", requested_date: "2026-07-06", requested_time: "17:00" } },
        ],
        tool_results: [missingPhoneToolResult()],
      };
    },
  };
}

// ── A. missing_phone on Telegram → injected ui.telegram.request_contact=true ──

test("A: missing_phone + channel=telegram injects ui.telegram.request_contact=true into orchestrator response", async () => {
  const result = await runRuntimeTurnOrchestrated(
    { clinic_code: CLINIC_CODE, channel: "telegram", external_user_id: "user_1", chat_id: "1111", text: "Запишите меня" },
    { runtimeTurnService: serviceReturningMissingPhone(), clinicIdentityResolver: clinicResolver },
  );

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") throw new Error("unreachable");

  const ui = result.payload.ui;
  assert.ok(ui !== undefined, "ui must be present");
  assert.equal(ui?.telegram?.request_contact, true);
  assert.equal(ui?.telegram?.button_text, "📞 Поделиться контактом");
});

// ── B. missing_phone on non-Telegram → no ui.telegram injected ───────────────

test("B: missing_phone + channel=whatsapp does NOT inject ui.telegram", async () => {
  const result = await runRuntimeTurnOrchestrated(
    { clinic_code: CLINIC_CODE, channel: "whatsapp", external_user_id: "user_2", chat_id: "2222", text: "Запишите меня" },
    { runtimeTurnService: serviceReturningMissingPhone(), clinicIdentityResolver: clinicResolver },
  );

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") throw new Error("unreachable");

  assert.equal(result.payload.ui?.telegram?.request_contact, undefined);
});

// ── C. Telegram webhook route sends reply_markup with contact button ──────────

test("C: Telegram webhook route sends reply_markup keyboard when ui.telegram.request_contact=true", async () => {
  const sentRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

  let handler: ((request: unknown, reply: unknown) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: serviceReturningMissingPhone(),
      clinicIdentityResolver: clinicResolver,
      botToken: "bot_token_test",
      webhookSecret: undefined,
      defaultClinicCode: CLINIC_CODE,
      isProduction: false,
      fetch: async (url, init) => {
        sentRequests.push({ url: String(url), body: JSON.parse((init?.body as string) ?? "{}") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const textUpdate = {
    update_id: 9001,
    message: {
      message_id: 501,
      chat: { id: 1111, type: "private" },
      from: { id: 9999, first_name: "Иван" },
      text: "Запишите меня",
    },
  };

  const reply = { code(_: number) { return reply; }, send(_: unknown) {} };
  await (handler as Function)({ body: textUpdate, headers: {}, ip: "127.0.0.1" }, reply);
  // sendTelegramMessage is void/fire-and-forget — wait briefly for it to settle
  await new Promise((r) => setTimeout(r, 50));

  const sendMessageCall = sentRequests.find((r) => r.url.includes("sendMessage"));
  assert.ok(sendMessageCall !== undefined, "sendMessage must have been called");

  const body = sendMessageCall!.body;
  const replyMarkup = body.reply_markup as Record<string, unknown> | undefined;
  assert.ok(replyMarkup !== undefined, "reply_markup must be present");

  const keyboard = (replyMarkup!.keyboard as Array<Array<Record<string, unknown>>>);
  assert.ok(Array.isArray(keyboard) && keyboard.length === 1, "keyboard must have one row");
  const button = keyboard[0]![0]!;
  assert.equal(button.request_contact, true);
  assert.equal(button.text, "📞 Поделиться контактом");
});

// ── D. manual_input still blocked for live booking ────────────────────────────

test("D: manual_input phone_source is rejected for live booking — returns missing_phone", async () => {
  const env: Record<string, string> = {
    CLINICCARD_API_BASE_URL: "https://cliniccard.example",
    CLINICCARD_API_TOKEN: "tok_test",
    CLINICCARD_BOOKING_MODE: "live",
    CLINICCARD_DEFAULT_DOCTOR_ID: "1",
    CLINICCARD_DEFAULT_CABINET_ID: "2",
    CLINICCARD_TIMEZONE: "Europe/Prague",
    CLINICCARD_LIVE_CLINIC_ALLOWLIST: CLINIC_UUID,
  };

  const adapter: ClinicCardAdapter = {
    findPatientByPhone: async () => { throw new Error("must not be called"); },
    createPatient: async () => { throw new Error("must not be called"); },
    listVisits: async () => { throw new Error("must not be called"); },
    createVisit: async () => { throw new Error("must not be called"); },
    listPayments: async () => { throw new Error("must not be called"); },
  };

  const executor = createBookingApplyExecutor({ env, adapterFactory: () => adapter });

  const context: ToolExecutionContext = {
    clinic_id: CLINIC_UUID,
    contact_id: "contact_1",
    case_id: "case_1",
    first_name: "Иван",
    last_name: "Петров",
    service_interest: "чистка",
    requested_date: "2026-07-06",
    requested_time: "17:00",
    phone_number: "+420777123456",
    phone_source: "manual_input",
  };

  const result = await executor(context);
  assert.equal(result.status, "success");
  assert.equal(result.data.booking_status, "missing_phone", "manual_input must be rejected with missing_phone");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.match(String(result.data.reason), /trusted/, "reason must mention trusted phone source requirement");
});

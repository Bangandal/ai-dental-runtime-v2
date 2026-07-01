/**
 * PR #117 — real admin notification side-effect.
 *
 * Covers:
 * A. notifier disabled -> no Telegram call, side_effect status=disabled, no patient claim.
 * B. notifier configured -> Telegram sendMessage called once, side_effect status=sent.
 * C. Telegram send fails -> side_effect status=failed, runtime still returns a safe reply.
 * D. no code path silently assumes a downstream layer delivers without a real attempt.
 * E. regression — visit_created / missing_phone do not trigger admin notification.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadAdminNotifyConfig } from "../src/integrations/adminNotify/adminNotifyConfig.ts";
import { createAdminNotifier } from "../src/integrations/adminNotify/telegramAdminNotifier.ts";
import { resolveAdminNotifyReason } from "../src/integrations/adminNotify/adminNotifyTrigger.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";
import { runRuntimeTurnOrchestrated } from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";

process.env.LEGACY_CASE_ROUTER_ENABLED = "false";

const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";
const CLINIC_CODE = "clinic_1";

const clinicIdentityResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC_UUID || input.clinic_identifier === CLINIC_CODE) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC_CODE } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "missing", retryable: false } };
  },
};

function bookingApplyToolResult(bookingStatus: string, overrides: Record<string, unknown> = {}): RuntimeAgentToolResult {
  return {
    tool: "booking.apply",
    status: "success",
    data: {
      booking_status: bookingStatus,
      created_visit: bookingStatus === "visit_created",
      may_claim_booked: bookingStatus === "visit_created",
      cliniccard_visit_id: bookingStatus === "visit_created" ? "visit_1" : null,
      ...overrides,
    },
  };
}

function serviceReturning(toolResults: RuntimeAgentToolResult[]): RuntimeTurnService {
  return {
    async runTurn() {
      return {
        final_patient_reply: "Пожалуйста, свяжитесь с клиникой напрямую.",
        tool_requests: [
          { tool: "booking.apply", arguments: { service: "чистка", requested_date: "2026-07-05", requested_time: "10:00" } },
        ],
        tool_results: toolResults,
      };
    },
  };
}

function baseBody() {
  return {
    clinic_code: CLINIC_CODE,
    channel: "telegram",
    external_user_id: "user_1",
    chat_id: "chat_1",
    text: "Хочу записаться",
  };
}

// ── config ───────────────────────────────────────────────────────────────────

test("loadAdminNotifyConfig defaults to disabled", () => {
  const config = loadAdminNotifyConfig({});
  assert.equal(config.mode, "disabled");
});

test("loadAdminNotifyConfig falls back to disabled when telegram mode has no chat id", () => {
  const config = loadAdminNotifyConfig({ ADMIN_NOTIFY_MODE: "telegram" });
  assert.equal(config.mode, "disabled");
});

test("loadAdminNotifyConfig accepts telegram mode with chat id", () => {
  const config = loadAdminNotifyConfig({ ADMIN_NOTIFY_MODE: "telegram", ADMIN_TELEGRAM_CHAT_ID: "-100200" });
  assert.equal(config.mode, "telegram");
  assert.equal(config.telegram_chat_id, "-100200");
});

// ── trigger resolution ───────────────────────────────────────────────────────

test("resolveAdminNotifyReason triggers for booking_write_disabled, config_missing, cliniccard_write_failed", () => {
  for (const status of ["booking_write_disabled", "config_missing", "cliniccard_write_failed"]) {
    const truth = buildBookingApplyActionTruth([bookingApplyToolResult(status)]);
    assert.equal(resolveAdminNotifyReason(truth), status);
  }
});

test("resolveAdminNotifyReason does not trigger for visit_created, missing_phone, slot_conflict", () => {
  for (const status of ["visit_created", "missing_phone", "slot_conflict"]) {
    const truth = buildBookingApplyActionTruth([bookingApplyToolResult(status)]);
    assert.equal(resolveAdminNotifyReason(truth), null);
  }
});

test("resolveAdminNotifyReason returns null when there is no booking.apply result", () => {
  assert.equal(resolveAdminNotifyReason(buildBookingApplyActionTruth([])), null);
});

// ── telegram notifier unit tests ────────────────────────────────────────────

const notifyPayload = {
  clinic_id: CLINIC_UUID,
  clinic_code: CLINIC_CODE,
  channel: "telegram",
  chat_id: "chat_1",
  external_user_id: "user_1",
  trace_id: "trace_1",
  patient_display_name: null,
  phone_source: null,
  phone_available: false,
  original_message: "Хочу записаться",
  requested_service: "чистка",
  requested_date: "2026-07-05",
  requested_time: "10:00",
  booking_status: "booking_write_disabled",
  created_visit: false,
  may_claim_booked: false,
  required_next_action: "admin_handoff",
  reason: "booking_write_disabled",
  timestamp: "2026-07-01T00:00:00.000Z",
};

test("A: notifier disabled -> no fetch call, status disabled", async () => {
  let fetchCalls = 0;
  const notifier = createAdminNotifier({
    config: { mode: "disabled", telegram_chat_id: null, telegram_thread_id: null },
    botToken: "tok",
    fetch: (async () => { fetchCalls++; return new Response("{}", { status: 200 }); }) as typeof fetch,
  });
  const result = await notifier.notify(notifyPayload);
  assert.equal(result.status, "disabled");
  assert.equal(fetchCalls, 0);
});

test("not_configured when telegram mode but no bot token", async () => {
  const notifier = createAdminNotifier({
    config: { mode: "telegram", telegram_chat_id: "-100200", telegram_thread_id: null },
    botToken: null,
  });
  const result = await notifier.notify(notifyPayload);
  assert.equal(result.status, "not_configured");
});

test("B: telegram notifier configured -> sendMessage called once, status sent", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const notifier = createAdminNotifier({
    config: { mode: "telegram", telegram_chat_id: "-100200", telegram_thread_id: null },
    botToken: "tok_admin",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const result = await notifier.notify(notifyPayload);
  assert.equal(result.status, "sent");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /tok_admin/);
  const sentBody = JSON.parse(calls[0].body);
  assert.equal(sentBody.chat_id, "-100200");
  assert.match(sentBody.text, /booking_write_disabled/);
});

test("C: telegram sendMessage fails -> status failed with error_code, no throw", async () => {
  const notifier = createAdminNotifier({
    config: { mode: "telegram", telegram_chat_id: "-100200", telegram_thread_id: null },
    botToken: "tok_admin",
    fetch: (async () => new Response("boom", { status: 500 })) as typeof fetch,
  });
  const result = await notifier.notify(notifyPayload);
  assert.equal(result.status, "failed");
  assert.ok(result.error_code);
});

// ── orchestrator wiring ──────────────────────────────────────────────────────

test("orchestrator: booking_write_disabled with notifier configured produces sent side_effect", async () => {
  const calls: unknown[] = [];
  const adminNotifier = createAdminNotifier({
    config: { mode: "telegram", telegram_chat_id: "-100200", telegram_thread_id: null },
    botToken: "tok_admin",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });

  const result = await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: serviceReturning([bookingApplyToolResult("booking_write_disabled")]),
    clinicIdentityResolver,
    adminNotifier,
  });

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") throw new Error("unreachable");
  assert.equal(result.payload.side_effects.length, 1);
  const sideEffect = result.payload.side_effects[0] as Record<string, unknown>;
  assert.equal(sideEffect.type, "admin_notification");
  assert.equal(sideEffect.status, "sent");
  assert.equal(sideEffect.reason, "booking_write_disabled");
  assert.equal(calls.length, 1);
  // Patient reply must not be rewritten/claimed by the orchestrator itself.
  assert.equal(result.payload.final_patient_reply, "Пожалуйста, свяжитесь с клиникой напрямую.");
});

test("orchestrator: notifier disabled -> side_effect status disabled, patient reply unaffected", async () => {
  const adminNotifier = createAdminNotifier({
    config: { mode: "disabled", telegram_chat_id: null, telegram_thread_id: null },
    botToken: null,
  });

  const result = await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: serviceReturning([bookingApplyToolResult("cliniccard_write_failed")]),
    clinicIdentityResolver,
    adminNotifier,
  });

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") throw new Error("unreachable");
  assert.equal(result.payload.side_effects.length, 1);
  const sideEffect = result.payload.side_effects[0] as Record<string, unknown>;
  assert.equal(sideEffect.status, "disabled");
});

test("E: visit_created does not produce an admin_notification side_effect", async () => {
  const adminNotifier = createAdminNotifier({
    config: { mode: "telegram", telegram_chat_id: "-100200", telegram_thread_id: null },
    botToken: "tok_admin",
    fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });

  const result = await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: serviceReturning([bookingApplyToolResult("visit_created")]),
    clinicIdentityResolver,
    adminNotifier,
  });

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") throw new Error("unreachable");
  assert.equal(result.payload.side_effects.length, 0);
});

test("E: missing_phone does not produce an admin_notification side_effect", async () => {
  const adminNotifier = createAdminNotifier({
    config: { mode: "telegram", telegram_chat_id: "-100200", telegram_thread_id: null },
    botToken: "tok_admin",
    fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });

  const result = await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: serviceReturning([bookingApplyToolResult("missing_phone")]),
    clinicIdentityResolver,
    adminNotifier,
  });

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") throw new Error("unreachable");
  assert.equal(result.payload.side_effects.length, 0);
});

test("orchestrator: no adminNotifier wired -> side_effects stays empty even for booking_write_disabled", async () => {
  const result = await runRuntimeTurnOrchestrated(baseBody(), {
    runtimeTurnService: serviceReturning([bookingApplyToolResult("booking_write_disabled")]),
    clinicIdentityResolver,
  });

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") throw new Error("unreachable");
  assert.equal(result.payload.side_effects.length, 0);
});

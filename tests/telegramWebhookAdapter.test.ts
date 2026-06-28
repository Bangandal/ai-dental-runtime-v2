import assert from "node:assert/strict";
import test from "node:test";

import {
  checkTelegramWebhookSecret,
  normalizeTelegramUpdate,
  type TelegramUpdate,
} from "../src/runtime/telegramWebhookAdapter.ts";
import { registerTelegramWebhookRoute } from "../src/runtime/telegramWebhookRoute.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";

// ── checkTelegramWebhookSecret ───────────────────────────────────────────────

test("checkTelegramWebhookSecret: missing secret in production fails closed (unconfigured)", () => {
  const result = checkTelegramWebhookSecret({
    configuredSecret: undefined,
    requestSecret: "anything",
    isProduction: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unconfigured");
});

test("checkTelegramWebhookSecret: missing secret outside production allows (dev convenience)", () => {
  const result = checkTelegramWebhookSecret({
    configuredSecret: undefined,
    requestSecret: undefined,
    isProduction: false,
  });
  assert.equal(result.ok, true);
});

test("checkTelegramWebhookSecret: correct secret allows", () => {
  const result = checkTelegramWebhookSecret({
    configuredSecret: "mysecret",
    requestSecret: "mysecret",
    isProduction: true,
  });
  assert.equal(result.ok, true);
});

test("checkTelegramWebhookSecret: wrong secret returns unauthorized", () => {
  const result = checkTelegramWebhookSecret({
    configuredSecret: "mysecret",
    requestSecret: "wrong",
    isProduction: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unauthorized");
});

test("checkTelegramWebhookSecret: missing request secret with configured secret returns unauthorized", () => {
  const result = checkTelegramWebhookSecret({
    configuredSecret: "mysecret",
    requestSecret: undefined,
    isProduction: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unauthorized");
});

// ── normalizeTelegramUpdate ──────────────────────────────────────────────────

const CLINIC = "clinic_1";

test("normalizeTelegramUpdate: maps user_id/chat_id/text/meta correctly", () => {
  const update: TelegramUpdate = {
    update_id: 100,
    message: {
      message_id: 42,
      chat: { id: 999, type: "private" },
      from: { id: 777, username: "jdoe", first_name: "John", last_name: "Doe" },
      text: "Привет",
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.external_user_id, "777");
  assert.equal(result.body.chat_id, "999");
  assert.equal(result.body.text, "Привет");
  assert.equal(result.body.channel, "telegram");
  assert.equal(result.body.clinic_code, CLINIC);
  assert.equal(result.body.meta.update_id, "100");
  assert.equal(result.body.meta.message_id, "42");
  assert.equal(result.body.meta.username, "jdoe");
  assert.equal(result.body.meta.first_name, "John");
  assert.equal(result.body.meta.last_name, "Doe");
  assert.equal(result.body.meta.telegram_chat_type, "private");
});

test("normalizeTelegramUpdate: optional username/last_name map to null", () => {
  const update: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1, first_name: "Anna" },
      text: "hi",
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.meta.username, null);
  assert.equal(result.body.meta.last_name, null);
});

test("normalizeTelegramUpdate: update without message returns no_message", () => {
  const update: TelegramUpdate = { update_id: 1 };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_message");
});

test("normalizeTelegramUpdate: update without text returns no_text", () => {
  const update: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1 },
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_text");
});

test("normalizeTelegramUpdate: edited_message returns edited_message", () => {
  const update: TelegramUpdate = {
    update_id: 1,
    edited_message: {
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      text: "edited",
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "edited_message");
});

test("normalizeTelegramUpdate: message without from returns no_from", () => {
  const update: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 1, type: "group" },
      text: "hello",
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_from");
});

// ── route integration ────────────────────────────────────────────────────────

const CLINIC_UUID = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";

const stubClinicResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
  },
};

interface SendCall {
  chatId: string;
  text: string;
}

function makeRouteHarness(opts: {
  webhookSecret?: string;
  isProduction?: boolean;
  replyText?: string;
}) {
  const sendCalls: SendCall[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sendCalls.push({ chatId: String(body.chat_id), text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const stubService: RuntimeTurnService = {
    async runTurn() {
      return {
        final_patient_reply: opts.replyText ?? "Привет от клиники",
        conversation_id: null,
        tool_requests: [],
        tool_results: [],
      };
    },
  };

  let handler: ((request: any, reply: any) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: stubService,
      clinicIdentityResolver: stubClinicResolver,
      botToken: "bot123",
      webhookSecret: opts.webhookSecret,
      defaultClinicCode: CLINIC,
      isProduction: opts.isProduction ?? false,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    },
  );
  assert.ok(handler);

  async function invoke(
    update: unknown,
    headers: Record<string, string> = {},
  ) {
    let statusCode = 200;
    let payload: unknown;
    const reply = {
      code(c: number) { statusCode = c; return reply; },
      send(p: unknown) { payload = p; },
    };
    await handler!({ body: update, headers, ip: "127.0.0.1" }, reply);
    await new Promise((r) => setTimeout(r, 20));
    return { statusCode, payload, sendCalls };
  }

  return { invoke, sendCalls };
}

const VALID_UPDATE: TelegramUpdate = {
  update_id: 1,
  message: {
    message_id: 10,
    chat: { id: 555, type: "private" },
    from: { id: 111, username: "testuser", first_name: "Test" },
    text: "Сколько стоит чистка?",
  },
};

test("route: missing webhook secret in production returns 401", async () => {
  const { invoke } = makeRouteHarness({ webhookSecret: undefined, isProduction: true });
  const { statusCode, payload } = await invoke(VALID_UPDATE, {});
  assert.equal(statusCode, 401);
  assert.equal((payload as any).error.code, "unauthorized");
});

test("route: wrong webhook secret returns 401", async () => {
  const { invoke } = makeRouteHarness({ webhookSecret: "secret", isProduction: true });
  const { statusCode } = await invoke(VALID_UPDATE, {
    "x-telegram-bot-api-secret-token": "wrong",
  });
  assert.equal(statusCode, 401);
});

test("route: valid webhook secret processes text message and returns 200", async () => {
  const { invoke } = makeRouteHarness({ webhookSecret: "secret" });
  const { statusCode } = await invoke(VALID_UPDATE, {
    "x-telegram-bot-api-secret-token": "secret",
  });
  assert.equal(statusCode, 200);
});

test("route: unsupported update (edited_message) returns 200 without LLM call", async () => {
  let llmCalled = false;
  let handler: ((request: any, reply: any) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: {
        async runTurn() {
          llmCalled = true;
          return { final_patient_reply: "x", conversation_id: null, tool_requests: [], tool_results: [] };
        },
      },
      clinicIdentityResolver: stubClinicResolver,
      botToken: "bot123",
      webhookSecret: undefined,
      defaultClinicCode: CLINIC,
      isProduction: false,
      fetch: async () => new Response("{}", { status: 200 }) as Response,
    },
  );
  const reply = { code(c: number) { return reply; }, send(_p: unknown) {} };
  await handler!({ body: { update_id: 1, edited_message: { message_id: 1, chat: { id: 1, type: "private" }, text: "edit" } }, headers: {}, ip: "127.0.0.1" }, reply);
  assert.equal(llmCalled, false);
});

test("route: sendMessage called with final_patient_reply only (no debug/conversation_id/tool_results)", async () => {
  const { invoke, sendCalls } = makeRouteHarness({
    webhookSecret: "secret",
    replyText: "Чистка стоит 1500 Kč",
  });
  await invoke(VALID_UPDATE, { "x-telegram-bot-api-secret-token": "secret" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]!.text, "Чистка стоит 1500 Kč");
  assert.equal(sendCalls[0]!.chatId, "555");
});

test("route: no debug/conversation_id/tool_results sent to Telegram", async () => {
  const sentPayloads: unknown[] = [];
  const fakeFetch = async (_url: string, init: RequestInit) => {
    sentPayloads.push(JSON.parse(init.body as string));
    return new Response("{}", { status: 200 }) as Response;
  };
  let handler: ((request: any, reply: any) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: {
        async runTurn() {
          return {
            final_patient_reply: "reply",
            conversation_id: "conv_123",
            tool_requests: [],
            tool_results: [{ tool: "kb.search", ok: true }],
            debug: { secret: "data" },
          };
        },
      },
      clinicIdentityResolver: stubClinicResolver,
      botToken: "bot123",
      webhookSecret: undefined,
      defaultClinicCode: CLINIC,
      isProduction: false,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    },
  );
  const reply = { code(c: number) { return reply; }, send(_p: unknown) {} };
  await handler!({ body: VALID_UPDATE, headers: {}, ip: "127.0.0.1" }, reply);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sentPayloads.length, 1);
  const sent = sentPayloads[0] as Record<string, unknown>;
  assert.equal("conversation_id" in sent, false);
  assert.equal("tool_results" in sent, false);
  assert.equal("debug" in sent, false);
  assert.equal(sent.text, "reply");
});

test("route: no ClinicCard write actions in Telegram adapter scope", () => {
  const src = `
    import { registerTelegramWebhookRoute } from "../src/runtime/telegramWebhookRoute.ts";
    import { sendTelegramMessage } from "../src/runtime/telegramSender.ts";
    import { checkTelegramWebhookSecret, normalizeTelegramUpdate } from "../src/runtime/telegramWebhookAdapter.ts";
  `;
  const forbidden = [
    "createPatient",
    "createVisit",
    "booking.apply",
    "slot_hold",
    "handoff.create",
    "admin.notify",
    "clinicCardAdapter",
    "CLINICCARD",
  ];
  for (const term of forbidden) {
    assert.ok(
      !src.includes(term) && !JSON.stringify(src).includes(term),
      `Forbidden term "${term}" found in Telegram adapter imports`,
    );
  }
});

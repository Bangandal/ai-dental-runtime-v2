import assert from "node:assert/strict";
import test from "node:test";

import {
  checkTelegramWebhookSecret,
  normalizeTelegramUpdate,
  type TelegramUpdate,
} from "../src/runtime/telegramWebhookAdapter.ts";
import { buildContactRequestReplyMarkup } from "../src/runtime/telegramSender.ts";
import { registerTelegramWebhookRoute } from "../src/runtime/telegramWebhookRoute.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";

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
  if (!result.ok || result.type !== "text") return;
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
  if (!result.ok || result.type !== "text") return;
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

// ── persistence / dedupe path tests ──────────────────────────────────────────

const CONTACT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLINIC_UUID_P = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";

function makePersistenceHarness(opts: {
  dedupeReturnsNull?: boolean;
  replyText?: string;
} = {}) {
  const contactCalls: unknown[] = [];
  const inboundEventCalls: unknown[] = [];
  const saveMessageCalls: unknown[] = [];
  const llmCalls: unknown[] = [];
  const sendCalls: Array<{ chatId: string; text: string }> = [];

  const stubPersistence: TurnPersistenceRepository = {
    async getOrCreateContact(input) {
      contactCalls.push(input);
      return { ok: true, data: { contact_id: CONTACT_UUID, clinic_id: CLINIC_UUID_P } };
    },
    async registerInboundEvent(input) {
      inboundEventCalls.push(input);
      if (opts.dedupeReturnsNull) {
        return { ok: true, data: { inbound_event_id: null } };
      }
      return { ok: true, data: { inbound_event_id: "evt_123" } };
    },
    async saveMessage(input) {
      saveMessageCalls.push(input);
      return { ok: true, data: { message_id: "msg_" + input.direction } };
    },
    async mergeConversationState() {
      return { ok: true, data: { ok: true } };
    },
  };

  const stubClinicRes: ClinicIdentityResolver = {
    async resolveClinicIdentity(input) {
      if (input.clinic_identifier === CLINIC) {
        return { ok: true, data: { clinic_id: CLINIC_UUID_P, clinic_code: CLINIC } };
      }
      return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
    },
  };

  const stubService: RuntimeTurnService = {
    async runTurn(input) {
      llmCalls.push(input);
      return {
        final_patient_reply: opts.replyText ?? "Ответ клиники",
        conversation_id: null,
        tool_requests: [],
        tool_results: [],
      };
    },
  };

  const fakeFetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sendCalls.push({ chatId: String(body.chat_id), text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  let handler: ((request: any, reply: any) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: stubService,
      clinicIdentityResolver: stubClinicRes,
      turnPersistenceRepository: stubPersistence,
      botToken: "bot123",
      webhookSecret: undefined,
      defaultClinicCode: CLINIC,
      isProduction: false,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    },
  );
  assert.ok(handler);

  async function invoke(update: unknown, headers: Record<string, string> = {}) {
    let statusCode = 200;
    let payload: unknown;
    const reply = {
      code(c: number) { statusCode = c; return reply; },
      send(p: unknown) { payload = p; },
    };
    await handler!({ body: update, headers, ip: "127.0.0.1" }, reply);
    await new Promise((r) => setTimeout(r, 30));
    return { statusCode, payload, contactCalls, inboundEventCalls, saveMessageCalls, llmCalls, sendCalls };
  }

  return { invoke };
}

const PERSISTENCE_UPDATE: TelegramUpdate = {
  update_id: 500,
  message: {
    message_id: 99,
    chat: { id: 888, type: "private" },
    from: { id: 222, username: "user222", first_name: "Ivan" },
    text: "Запишите меня на чистку",
  },
};

test("route: contact is created/resolved via persistence repository", async () => {
  const { invoke } = makePersistenceHarness();
  const { contactCalls } = await invoke(PERSISTENCE_UPDATE);
  assert.equal(contactCalls.length, 1);
  const call = contactCalls[0] as Record<string, unknown>;
  assert.equal(call.clinic_code, CLINIC);
  assert.equal(call.channel, "telegram");
  assert.equal(call.external_user_id, "222");
  assert.equal(call.chat_id, "888");
  assert.equal(call.username, "user222");
  assert.equal(call.first_name, "Ivan");
});

test("route: inbound event is persisted with dedupe_key", async () => {
  const { invoke } = makePersistenceHarness();
  const { inboundEventCalls } = await invoke(PERSISTENCE_UPDATE);
  assert.equal(inboundEventCalls.length, 1);
  const call = inboundEventCalls[0] as Record<string, unknown>;
  assert.equal(call.contact_id, CONTACT_UUID);
  assert.equal(call.channel, "telegram");
  assert.equal(typeof call.dedupe_key, "string");
  assert.ok((call.dedupe_key as string).includes("500"), "dedupe_key must reference update_id");
});

test("route: outbound assistant message is persisted after LLM response", async () => {
  const { invoke } = makePersistenceHarness({ replyText: "Готово!" });
  const { saveMessageCalls } = await invoke(PERSISTENCE_UPDATE);
  const outbound = (saveMessageCalls as Array<Record<string, unknown>>).filter((m) => m.direction === "outbound");
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]!.role, "assistant");
  assert.equal(outbound[0]!.text, "Готово!");
  assert.equal(outbound[0]!.contact_id, CONTACT_UUID);
});

test("route: duplicate update_id returns 200 without calling LLM", async () => {
  const { invoke } = makePersistenceHarness({ dedupeReturnsNull: true });
  const { statusCode, llmCalls } = await invoke(PERSISTENCE_UPDATE);
  assert.equal(statusCode, 200);
  assert.equal(llmCalls.length, 0);
});

test("route: duplicate update_id returns 200 without sending Telegram message", async () => {
  const { invoke } = makePersistenceHarness({ dedupeReturnsNull: true });
  const { statusCode, sendCalls } = await invoke(PERSISTENCE_UPDATE);
  assert.equal(statusCode, 200);
  assert.equal(sendCalls.length, 0);
});

// ── contact normalization ─────────────────────────────────────────────────────

const CONTACT_UPDATE: TelegramUpdate = {
  update_id: 200,
  message: {
    message_id: 55,
    chat: { id: 333, type: "private" },
    from: { id: 444, username: "pat", first_name: "Olga", last_name: "Petrenko" },
    contact: {
      phone_number: "+380991234567",
      first_name: "Olga",
      last_name: "Petrenko",
      user_id: 444,
    },
  },
};

test("normalizeTelegramUpdate: contact update normalizes to type=contact", () => {
  const result = normalizeTelegramUpdate(CONTACT_UPDATE, CLINIC, new Date("2026-06-29T10:00:00.000Z"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.type, "contact");
});

test("normalizeTelegramUpdate: contact capture has correct phone and phone_source", () => {
  const result = normalizeTelegramUpdate(CONTACT_UPDATE, CLINIC, new Date("2026-06-29T10:00:00.000Z"));
  if (!result.ok || result.type !== "contact") { assert.fail("expected contact"); return; }
  assert.equal(result.capture.phone_number, "+380991234567");
  assert.equal(result.capture.phone_source, "telegram_contact_button");
});

test("normalizeTelegramUpdate: contact capture has phone_consent=true", () => {
  const result = normalizeTelegramUpdate(CONTACT_UPDATE, CLINIC, new Date("2026-06-29T10:00:00.000Z"));
  if (!result.ok || result.type !== "contact") { assert.fail("expected contact"); return; }
  assert.equal(result.capture.phone_consent, true);
});

test("normalizeTelegramUpdate: contact capture has phone_collected_at as ISO string", () => {
  const now = new Date("2026-06-29T10:00:00.000Z");
  const result = normalizeTelegramUpdate(CONTACT_UPDATE, CLINIC, now);
  if (!result.ok || result.type !== "contact") { assert.fail("expected contact"); return; }
  assert.equal(result.capture.phone_collected_at, "2026-06-29T10:00:00.000Z");
});

test("normalizeTelegramUpdate: contact capture preserves first_name, last_name, user_id", () => {
  const result = normalizeTelegramUpdate(CONTACT_UPDATE, CLINIC, new Date("2026-06-29T10:00:00.000Z"));
  if (!result.ok || result.type !== "contact") { assert.fail("expected contact"); return; }
  assert.equal(result.capture.telegram_contact.first_name, "Olga");
  assert.equal(result.capture.telegram_contact.last_name, "Petrenko");
  assert.equal(result.capture.telegram_contact.user_id, 444);
});

test("normalizeTelegramUpdate: contact without phone_number returns no_contact_phone", () => {
  const update: TelegramUpdate = {
    update_id: 201,
    message: {
      message_id: 56,
      chat: { id: 333, type: "private" },
      from: { id: 444 },
      contact: { first_name: "Olga" },
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_contact_phone");
});

test("normalizeTelegramUpdate: contact update chat_id and external_user_id are set correctly", () => {
  const result = normalizeTelegramUpdate(CONTACT_UPDATE, CLINIC, new Date("2026-06-29T10:00:00.000Z"));
  if (!result.ok || result.type !== "contact") { assert.fail("expected contact"); return; }
  assert.equal(result.chat_id, "333");
  assert.equal(result.external_user_id, "444");
  assert.equal(result.update_id, "200");
  assert.equal(result.clinic_code, CLINIC);
});

// ── contact button reply_markup ───────────────────────────────────────────────

test("buildContactRequestReplyMarkup: default button text", () => {
  const markup = buildContactRequestReplyMarkup();
  assert.equal(markup.keyboard[0]![0]!.text, "📞 Поделиться номером");
  assert.equal(markup.keyboard[0]![0]!.request_contact, true);
});

test("buildContactRequestReplyMarkup: custom button text", () => {
  const markup = buildContactRequestReplyMarkup("Share number");
  assert.equal(markup.keyboard[0]![0]!.text, "Share number");
});

test("buildContactRequestReplyMarkup: one_time_keyboard and resize_keyboard are set", () => {
  const markup = buildContactRequestReplyMarkup();
  assert.equal(markup.one_time_keyboard, true);
  assert.equal(markup.resize_keyboard, true);
});

test("route: ui.telegram.request_contact=true sends reply_markup in sendMessage", async () => {
  const sentPayloads: unknown[] = [];
  const fakeFetch = async (_url: string, init: RequestInit) => {
    sentPayloads.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  let handler: ((request: any, reply: any) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: {
        async runTurn() {
          return {
            final_patient_reply: "Поделитесь номером телефона кнопкой ниже.",
            conversation_id: null,
            tool_requests: [],
            tool_results: [],
            ui: { telegram: { request_contact: true, button_text: "📞 Поделиться номером" } },
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
  const markup = sent.reply_markup as Record<string, unknown>;
  assert.ok(markup, "reply_markup should be present");
  assert.equal(markup.one_time_keyboard, true);
  assert.equal(markup.resize_keyboard, true);
  const kb = markup.keyboard as Array<Array<Record<string, unknown>>>;
  assert.equal(kb[0]![0]!.request_contact, true);
  assert.equal(kb[0]![0]!.text, "📞 Поделиться номером");
});

test("route: no ui → no reply_markup sent", async () => {
  const sentPayloads: unknown[] = [];
  const fakeFetch = async (_url: string, init: RequestInit) => {
    sentPayloads.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  let handler: ((request: any, reply: any) => Promise<void>) | undefined;
  registerTelegramWebhookRoute(
    { post(_path, h) { handler = h; } },
    {
      runtimeTurnService: {
        async runTurn() {
          return {
            final_patient_reply: "Чем могу помочь?",
            conversation_id: null,
            tool_requests: [],
            tool_results: [],
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
  const sent = sentPayloads[0] as Record<string, unknown>;
  assert.equal("reply_markup" in sent, false, "reply_markup must not be present when no ui");
});

test("route: contact update returns 200 without LLM call", async () => {
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
  let statusCode = 200;
  const reply = { code(c: number) { statusCode = c; return reply; }, send(_p: unknown) {} };
  await handler!({ body: CONTACT_UPDATE, headers: {}, ip: "127.0.0.1" }, reply);
  assert.equal(statusCode, 200);
  assert.equal(llmCalled, false);
});

// ── scope guard ───────────────────────────────────────────────────────────────

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

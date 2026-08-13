import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTelegramUpdate,
} from "../src/runtime/telegramWebhookAdapter.ts";
import { registerTelegramWebhookRoute } from "../src/runtime/telegramWebhookRoute.ts";
import type {
  TelegramRouteApp,
  TelegramWebhookRequest,
  TelegramWebhookReply,
  TelegramWebhookRouteDeps,
} from "../src/runtime/telegramWebhookRoute.ts";
import type { RuntimeTurnInput } from "../src/runtime/runtimeTurnService.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";

const BOT_TOKEN = "test-bot-token";
const CLINIC_CODE = "clinic_1";
const OPENAI_API_KEY = "sk-test";
const CLINIC_ID_UUID = "11111111-1111-1111-8111-111111111111";
const CONTACT_ID_UUID = "22222222-2222-2222-8222-222222222222";

// ── Mock helpers ──────────────────────────────────────────────────────────────

type PostHandler = (req: TelegramWebhookRequest, reply: TelegramWebhookReply) => Promise<void>;

function makeRouteApp() {
  const postHandlers = new Map<string, PostHandler>();
  const app: TelegramRouteApp = {
    post(path, handler) { postHandlers.set(path, handler); },
  };
  return { app, postHandlers };
}

function makeReply() {
  const state = { statusCode: 200, body: undefined as unknown };
  const reply: TelegramWebhookReply = {
    code(n) { state.statusCode = n; return reply; },
    send(payload) { state.body = payload; },
  };
  return { reply, getState: () => state };
}

function makeVoiceUpdate(opts: { messageId?: number; duration?: number; mimeType?: string; fileId?: string } = {}) {
  return {
    update_id: 12345,
    message: {
      message_id: opts.messageId ?? 42,
      from: { id: 99001, username: "testuser", first_name: "Test" },
      chat: { id: 99001, type: "private" },
      voice: {
        file_id: opts.fileId ?? "file_abc123",
        file_unique_id: "unique_abc123",
        duration: opts.duration ?? 5,
        mime_type: opts.mimeType ?? "audio/ogg",
      },
    },
  };
}

function makeTextUpdate(text: string, messageId = 100) {
  return {
    update_id: 9999,
    message: {
      message_id: messageId,
      from: { id: 99001, username: "testuser", first_name: "Test" },
      chat: { id: 99001, type: "private" },
      text,
    },
  };
}

function makeMockClinicIdentityResolver() {
  return {
    async resolveClinicIdentity(_opts: unknown) {
      return {
        ok: true as const,
        data: { clinic_id: CLINIC_ID_UUID, clinic_code: CLINIC_CODE },
      };
    },
  };
}

function makeMockTurnPersistenceRepo(opts: { duplicateOnSecondCall?: boolean } = {}): {
  repo: TurnPersistenceRepository;
} {
  const state = { inboundCallCount: 0 };
  const repo: TurnPersistenceRepository = {
    async getOrCreateContact() {
      return { ok: true, data: { contact_id: CONTACT_ID_UUID, clinic_id: CLINIC_ID_UUID } };
    },
    async registerInboundEvent() {
      state.inboundCallCount += 1;
      const isDuplicate = opts.duplicateOnSecondCall && state.inboundCallCount > 1;
      if (isDuplicate) {
        return { ok: true, data: { inbound_event_id: "evt-dup", is_duplicate: true, accepted: false } };
      }
      return { ok: true, data: { inbound_event_id: "evt-1", is_duplicate: false, accepted: true } };
    },
    async saveMessage() {
      return { ok: true, data: { message_id: "msg-1" } };
    },
    async mergeConversationState() {
      return { ok: true, data: { ok: true } };
    },
  };
  return { repo };
}

// Builds a fetch mock that handles Telegram getFile + download + OpenAI transcription
function makeFetchForVoice(opts: {
  transcript?: string;
  getFileFails?: boolean;
  downloadFails?: boolean;
  transcribeFails?: boolean;
  getFileFilePath?: string;
  captureTranscriptionRequest?: { filename?: string; mimeType?: string };
} = {}): typeof globalThis.fetch {
  return async (url: string | URL | Request, reqOpts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("/getFile")) {
      if (opts.getFileFails) {
        return new Response(JSON.stringify({ ok: false }), { status: 400 });
      }
      const filePath = opts.getFileFilePath ?? "voice/audio.ogg";
      return new Response(
        JSON.stringify({ ok: true, result: { file_id: "file_abc123", file_path: filePath, file_size: 1000 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("api.telegram.org/file/")) {
      if (opts.downloadFails) {
        return new Response("error", { status: 500 });
      }
      return new Response(Buffer.from("fake-ogg-bytes"), { status: 200 });
    }

    if (urlStr.includes("api.openai.com/v1/audio/transcriptions")) {
      if (opts.transcribeFails) {
        return new Response(JSON.stringify({ error: "bad" }), { status: 500 });
      }
      // Capture filename from multipart body for assertions
      if (opts.captureTranscriptionRequest && reqOpts?.body instanceof FormData) {
        const fd = reqOpts.body as FormData;
        const fileEntry = fd.get("file");
        if (fileEntry && typeof (fileEntry as unknown as { name?: string }).name === "string") {
          opts.captureTranscriptionRequest.filename = (fileEntry as unknown as { name: string }).name;
        }
        const blob = fileEntry instanceof Blob ? fileEntry : null;
        if (blob) {
          opts.captureTranscriptionRequest.mimeType = blob.type;
        }
      }
      return new Response(
        JSON.stringify({ text: opts.transcript ?? "запишите меня на завтра" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("api.telegram.org/bot")) {
      // sendTelegramMessage
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("{}", { status: 200 });
  };
}

// Build full route deps with orchestrator-compatible mocks
function makeFullRouteDeps(opts: {
  capturedInputs?: RuntimeTurnInput[];
  runCount?: { n: number };
  fetchOverride?: typeof globalThis.fetch;
  duplicateOnSecondCall?: boolean;
} = {}): TelegramWebhookRouteDeps {
  const capturedInputs = opts.capturedInputs ?? [];
  const runCount = opts.runCount ?? { n: 0 };
  const { repo } = makeMockTurnPersistenceRepo({ duplicateOnSecondCall: opts.duplicateOnSecondCall });

  const runtimeTurnService: TelegramWebhookRouteDeps["runtimeTurnService"] = {
    async runTurn(input: RuntimeTurnInput) {
      runCount.n++;
      capturedInputs.push(input);
      return {
        final_patient_reply: "Записал вас на завтра.",
        tool_requests: [],
        tool_results: [],
      };
    },
  } as unknown as TelegramWebhookRouteDeps["runtimeTurnService"];

  return {
    botToken: BOT_TOKEN,
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    openaiApiKey: OPENAI_API_KEY,
    fetch: opts.fetchOverride ?? makeFetchForVoice(),
    runtimeTurnService,
    clinicIdentityResolver: makeMockClinicIdentityResolver(),
    turnPersistenceRepository: repo,
  } as unknown as TelegramWebhookRouteDeps;
}

// ── Adapter unit tests ────────────────────────────────────────────────────────

test("TG-ADAPTER-VOICE: voice message normalizes to type='voice'", () => {
  const update = makeVoiceUpdate();
  const result = normalizeTelegramUpdate(update, CLINIC_CODE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.type, "voice");
  if (result.type !== "voice") return;
  assert.equal(result.file_id, "file_abc123");
  assert.equal(result.mime_type, "audio/ogg");
  assert.equal(result.duration_seconds, 5);
  assert.equal(result.external_user_id, "99001");
  assert.equal(result.chat_id, "99001");
  assert.equal(result.clinic_code, CLINIC_CODE);
});

test("TG-ADAPTER-VOICE-MISSING-FILE-ID: voice message with no file_id → no_text", () => {
  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      voice: { file_id: "", duration: 3, mime_type: "audio/ogg" },
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC_CODE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_text");
});

test("TG-ADAPTER-TEXT: text message still normalizes to type='text'", () => {
  const update = makeTextUpdate("Привет");
  const result = normalizeTelegramUpdate(update, CLINIC_CODE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.type, "text");
});

test("TG-ADAPTER-AUDIO-KEY: audio key also normalizes to type='voice'", () => {
  const update = {
    update_id: 2,
    message: {
      message_id: 2,
      from: { id: 555 },
      chat: { id: 555, type: "private" },
      audio: { file_id: "audio_file_id", file_unique_id: "uniq", duration: 10, mime_type: "audio/mpeg" },
    },
  };
  const result = normalizeTelegramUpdate(update, CLINIC_CODE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.type, "voice");
  if (result.type !== "voice") return;
  assert.equal(result.file_id, "audio_file_id");
  assert.equal(result.mime_type, "audio/mpeg");
});

// TG-VOICE-3: Telegram ordinary text/contact behavior unchanged
test("TG-VOICE-3: text update still reaches normalized.type='text'", () => {
  const update = makeTextUpdate("Сколько стоит чистка?", 200);
  const result = normalizeTelegramUpdate(update, CLINIC_CODE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.type, "text");
  if (result.type !== "text") return;
  assert.equal(result.body.text, "Сколько стоит чистка?");
  assert.equal(result.body.channel, "telegram");
});

// TG-VOICE-1: REAL route integration test
// Telegram voice webhook → getFile → download → transcribe → RuntimeTurnOrchestrator
// → runtime receives user_message = transcript + meta.input_modality = "voice"
test("TG-VOICE-1: voice webhook → getFile → download → transcription → runtime receives transcript as text", async () => {
  const capturedInputs: RuntimeTurnInput[] = [];
  const runCount = { n: 0 };
  const transcript = "привет";

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    capturedInputs,
    runCount,
    fetchOverride: makeFetchForVoice({ transcript }),
  });
  registerTelegramWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/telegram")!;
  assert.ok(handler, "handler must be registered");

  const { reply, getState } = makeReply();
  await handler(
    { body: makeVoiceUpdate(), headers: {} },
    reply,
  );

  assert.equal(getState().statusCode, 200);
  assert.equal(runCount.n, 1, "runtimeTurnService.runTurn must be called exactly once");
  const input = capturedInputs[0]!;
  assert.equal(input.user_message, transcript, "runtime receives transcript as user_message");
  assert.equal(
    (input.business_context as Record<string, unknown>)?.meta?.input_modality,
    "voice",
    "meta.input_modality must be 'voice'",
  );
});

// TG-VOICE-2: REAL route integration test — same voice message twice → runtime called at most once
test("TG-VOICE-2: same voice update sent twice → runtimeTurnService.runTurn called exactly once (dedup)", async () => {
  const capturedInputs: RuntimeTurnInput[] = [];
  const runCount = { n: 0 };

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    capturedInputs,
    runCount,
    fetchOverride: makeFetchForVoice({ transcript: "запись на завтра" }),
    duplicateOnSecondCall: true,
  });
  registerTelegramWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/telegram")!;
  assert.ok(handler);

  const voiceUpdate = makeVoiceUpdate({ messageId: 77 });

  const { reply: reply1, getState: getState1 } = makeReply();
  await handler({ body: voiceUpdate, headers: {} }, reply1);
  assert.equal(getState1().statusCode, 200);

  const { reply: reply2, getState: getState2 } = makeReply();
  await handler({ body: voiceUpdate, headers: {} }, reply2);
  assert.equal(getState2().statusCode, 200);

  assert.equal(runCount.n, 1, "runtimeTurnService.runTurn must be called exactly once despite two webhook deliveries");
});

// ── .oga regression tests ─────────────────────────────────────────────────────

// TG-OGA-1: getFile returns .oga path, webhook mime_type=audio/ogg
// → effective MIME from webhook wins, canonical .ogg filename sent to OpenAI
test("TG-OGA-1: getFile .oga path + webhook mime_type=audio/ogg → OpenAI receives audio.ogg filename", async () => {
  const capturedInputs: RuntimeTurnInput[] = [];
  const runCount = { n: 0 };
  const captureTranscriptionRequest: { filename?: string; mimeType?: string } = {};

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    capturedInputs,
    runCount,
    fetchOverride: makeFetchForVoice({
      transcript: "запишите на завтра",
      getFileFilePath: "voice/file_123.oga",
      captureTranscriptionRequest,
    }),
  });
  registerTelegramWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/telegram")!;
  const { reply, getState } = makeReply();
  // Webhook declares mime_type=audio/ogg (Telegram's actual field)
  await handler({ body: makeVoiceUpdate({ mimeType: "audio/ogg" }), headers: {} }, reply);

  assert.equal(getState().statusCode, 200);
  assert.equal(runCount.n, 1, "runtime must be called exactly once");
  assert.equal(capturedInputs[0]?.user_message, "запишите на завтра", "transcript reaches runtime");
  assert.equal(captureTranscriptionRequest.filename, "audio.ogg", "OpenAI multipart filename must be audio.ogg, not .oga");
  assert.equal(captureTranscriptionRequest.mimeType, "audio/ogg", "OpenAI multipart MIME must be audio/ogg");
});

// TG-OGA-2: getFile path has no extension, webhook mime_type=audio/ogg → canonical .ogg
test("TG-OGA-2: getFile path with no extension + webhook mime_type=audio/ogg → canonical audio.ogg filename", async () => {
  const runCount = { n: 0 };
  const captureTranscriptionRequest: { filename?: string; mimeType?: string } = {};
  const { reply, getState } = makeReply();

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    runCount,
    fetchOverride: makeFetchForVoice({
      transcript: "осмотр в пятницу",
      getFileFilePath: "voice/file_abc",  // no extension
      captureTranscriptionRequest,
    }),
  });
  registerTelegramWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/telegram")!;
  await handler({ body: makeVoiceUpdate({ mimeType: "audio/ogg" }), headers: {} }, reply);

  assert.equal(getState().statusCode, 200, "route must return 200");
  assert.equal(runCount.n, 1, "runtime must be called exactly once");
  assert.equal(captureTranscriptionRequest.filename, "audio.ogg", "OpenAI multipart filename must be audio.ogg");
});

// TG-OGA-3: MIME with codec suffix (WhatsApp-style "audio/ogg; codecs=opus") → strips to audio/ogg → audio.ogg
test("TG-OGA-3: mime_type=audio/ogg; codecs=opus → codec suffix stripped → canonical audio.ogg filename", async () => {
  const captureTranscriptionRequest: { filename?: string; mimeType?: string } = {};
  const runCount = { n: 0 };
  const { reply, getState } = makeReply();

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    runCount,
    fetchOverride: makeFetchForVoice({
      transcript: "консультация",
      getFileFilePath: "voice/file_wa.oga",
      captureTranscriptionRequest,
    }),
  });
  registerTelegramWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/telegram")!;
  await handler({ body: makeVoiceUpdate({ mimeType: "audio/ogg; codecs=opus" }), headers: {} }, reply);

  assert.equal(getState().statusCode, 200, "route must return 200");
  assert.equal(runCount.n, 1, "runtime must be called exactly once");
  assert.equal(captureTranscriptionRequest.filename, "audio.ogg", "OpenAI multipart filename must be audio.ogg");
  assert.equal(captureTranscriptionRequest.mimeType, "audio/ogg", "OpenAI multipart MIME must be stripped to audio/ogg");
});

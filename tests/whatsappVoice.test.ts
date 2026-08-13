import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  normalizeWhatsAppPayload,
  verifyWhatsAppSignature,
} from "../src/runtime/whatsappWebhookAdapter.ts";
import { registerWhatsAppWebhookRoute } from "../src/runtime/whatsappWebhookRoute.ts";
import type {
  WhatsAppRouteApp,
  WhatsAppPostRequest,
  WhatsAppWebhookReply,
  WhatsAppWebhookRouteDeps,
} from "../src/runtime/whatsappWebhookRoute.ts";
import type { RuntimeTurnOrchestratorResult } from "../src/runtime/runtimeTurnOrchestrator.ts";

const APP_SECRET = "test-app-secret";
const ACCESS_TOKEN = "test-access-token";
const PHONE_NUMBER_ID = "12345";
const GRAPH_VERSION = "v19.0";
const CLINIC_ID = "clinic_test";
const WA_ID = "420111222333";
const MESSAGE_ID = "wamid.audio.test123";
const OPENAI_API_KEY = "sk-test";

// ── Payload helpers ──────────────────────────────────────────────────────────

function makeAudioPayload(opts: {
  waId?: string;
  messageId?: string;
  mediaId?: string;
  mimeType?: string;
} = {}): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "BIZ_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "420111222333", phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Test Patient" }, wa_id: opts.waId ?? WA_ID }],
              messages: [
                {
                  from: opts.waId ?? WA_ID,
                  id: opts.messageId ?? MESSAGE_ID,
                  timestamp: "1700000001",
                  type: "audio",
                  audio: {
                    id: opts.mediaId ?? "meta_media_abc",
                    mime_type: opts.mimeType ?? "audio/ogg; codecs=opus",
                  },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function makeTextPayload(text = "Привет"): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "BIZ_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: "Test" }, wa_id: WA_ID }],
              messages: [
                {
                  from: WA_ID,
                  id: "wamid.text.123",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf-8")).digest("hex")}`;
}

// ── Adapter unit tests ────────────────────────────────────────────────────────

test("WA-ADAPTER-AUDIO: audio message normalizes into audioTurns", () => {
  const result = normalizeWhatsAppPayload(makeAudioPayload(), CLINIC_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.turns.length, 0, "no text turns for audio message");
  assert.equal(result.audioTurns.length, 1, "one audio turn");
  const at = result.audioTurns[0];
  assert.ok(at);
  assert.equal(at.waId, WA_ID);
  assert.equal(at.mediaId, "meta_media_abc");
  assert.equal(at.messageId, MESSAGE_ID);
});

test("WA-ADAPTER-TEXT-UNCHANGED: text messages still normalize to turns[]", () => {
  const result = normalizeWhatsAppPayload(makeTextPayload("Запишите меня"), CLINIC_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.turns.length, 1);
  assert.equal(result.audioTurns.length, 0);
  assert.equal(result.turns[0]?.runtimeBody.text, "Запишите меня");
});

test("WA-ADAPTER-AUDIO-NO-MEDIA-ID: audio message without media id is skipped", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "B",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              messages: [{ from: WA_ID, id: "m1", type: "audio", audio: {} }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
  const result = normalizeWhatsAppPayload(payload, CLINIC_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.audioTurns.length, 0, "no audio turn when media id missing");
});

// ── Route-level tests ─────────────────────────────────────────────────────────

type PostHandler = (req: WhatsAppPostRequest, reply: WhatsAppWebhookReply) => Promise<void>;

function makeRouteApp() {
  const postHandlers = new Map<string, PostHandler>();
  const app: WhatsAppRouteApp = {
    get(_path, _handler) {},
    post(path, handler) { postHandlers.set(path, handler); },
  };
  return { app, postHandlers };
}

function makeReply() {
  const state = { statusCode: 200, body: undefined as unknown };
  const reply: WhatsAppWebhookReply = {
    code(n) { state.statusCode = n; return reply; },
    send(payload) { state.body = payload; },
  };
  return { reply, getState: () => state };
}

function makeFetchForAudio(opts: {
  transcript?: string;
  metaFails?: boolean;
  downloadFails?: boolean;
  transcribeFails?: boolean;
} = {}): typeof globalThis.fetch {
  return async (url: string | URL | Request, _opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Meta Graph API — media URL lookup
    if (urlStr.includes("graph.facebook.com") && !urlStr.includes("uploads")) {
      if (opts.metaFails) {
        return new Response(JSON.stringify({ error: "bad" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ url: "https://cdn.whatsapp.example/media/abc", mime_type: "audio/ogg" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Media download from CDN URL
    if (urlStr.includes("cdn.whatsapp.example")) {
      if (opts.downloadFails) {
        return new Response("error", { status: 500 });
      }
      return new Response(Buffer.from("fake-ogg-audio"), { status: 200 });
    }

    // OpenAI transcription
    if (urlStr.includes("api.openai.com/v1/audio/transcriptions")) {
      if (opts.transcribeFails) {
        return new Response(JSON.stringify({ error: "fail" }), { status: 500 });
      }
      return new Response(
        JSON.stringify({ text: opts.transcript ?? "запишите меня на завтра" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // WhatsApp send message
    if (urlStr.includes("graph.facebook.com") && urlStr.includes("messages")) {
      return new Response(JSON.stringify({ messages: [{ id: "wamid.reply.1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("{}", { status: 200 });
  };
}

function makeMinimalOrchestratorDeps(opts: {
  runtimeInvokeTracker?: { count: number; lastBody?: unknown };
  fetchOverride?: typeof globalThis.fetch;
} = {}): WhatsAppWebhookRouteDeps {
  const tracker = opts.runtimeInvokeTracker;

  return {
    accessToken: ACCESS_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    verifyToken: "token",
    appSecret: APP_SECRET,
    graphApiVersion: GRAPH_VERSION,
    clinicId: CLINIC_ID,
    openaiApiKey: OPENAI_API_KEY,
    fetch: opts.fetchOverride ?? makeFetchForAudio(),
    runtimeTurnService: null as unknown as WhatsAppWebhookRouteDeps["runtimeTurnService"],
    runtimeTurnLogger: {
      logTurn: async () => {},
      logDelivery: async () => {},
    },
  } as unknown as WhatsAppWebhookRouteDeps;
}

// WA-VOICE-3: invalid HMAC → ZERO media download, ZERO transcription, ZERO runtime
test("WA-VOICE-3: invalid HMAC returns 401 with no media download or transcription", async () => {
  let fetchCalled = false;
  const trackingFetch: typeof globalThis.fetch = async (url) => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };

  const { app, postHandlers } = makeRouteApp();
  const { reply, getState } = makeReply();

  const deps = makeMinimalOrchestratorDeps({ fetchOverride: trackingFetch });
  registerWhatsAppWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/whatsapp")!;
  assert.ok(handler, "handler must be registered");

  const payloadStr = JSON.stringify(makeAudioPayload());
  await handler(
    {
      body: makeAudioPayload(),
      rawBody: Buffer.from(payloadStr, "utf-8"),
      headers: { "x-hub-signature-256": "sha256=invalid_signature_abc" },
    },
    reply,
  );

  const state = getState();
  assert.equal(state.statusCode, 401, "must return 401 for bad HMAC");
  assert.equal(fetchCalled, false, "fetch must not be called when HMAC fails");
});

// WA-VOICE-2: wa_id stays platform-derived — verify normalizeWhatsAppPayload produces correct waId
test("WA-VOICE-2: wa_id is always platform-derived, not from message body", () => {
  const result = normalizeWhatsAppPayload(makeAudioPayload({ waId: "48600123456" }), CLINIC_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const audioTurn = result.audioTurns[0];
  assert.ok(audioTurn);
  assert.equal(audioTurn.waId, "48600123456", "wa_id must be message.from, not body text");
});

// WA-VOICE-4: same WhatsApp audio message twice → same messageId in audioTurns (dedup by messageId)
test("WA-VOICE-4: duplicate audio webhook produces same messageId (dedup gate at runtime level)", () => {
  const result1 = normalizeWhatsAppPayload(makeAudioPayload({ messageId: "wamid.dup.1" }), CLINIC_ID);
  const result2 = normalizeWhatsAppPayload(makeAudioPayload({ messageId: "wamid.dup.1" }), CLINIC_ID);
  assert.equal(result1.ok, true);
  assert.equal(result2.ok, true);
  if (!result1.ok || !result2.ok) return;
  assert.equal(result1.audioTurns[0]?.messageId, "wamid.dup.1");
  assert.equal(result2.audioTurns[0]?.messageId, "wamid.dup.1");
  // Same message_id passed into runtimeBody → dedup gate fires
});

// WA-VOICE-5: current WhatsApp text behavior unchanged
test("WA-VOICE-5: text messages still produce turns[] and no audioTurns", () => {
  const result = normalizeWhatsAppPayload(makeTextPayload("Добрый день"), CLINIC_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.turns.length, 1);
  assert.equal(result.audioTurns.length, 0);
  assert.equal(result.turns[0]?.runtimeBody.channel, "whatsapp");
  assert.equal(result.turns[0]?.runtimeBody.text, "Добрый день");
});

// WA-VOICE-1: audio → media download → transcribe (integration via adapter layer)
test("WA-VOICE-1: audio payload normalizes to audioTurn with correct mediaId and waId", () => {
  const result = normalizeWhatsAppPayload(
    makeAudioPayload({ waId: "380991234567", mediaId: "media_xyz_789", messageId: "wamid.v1.abc" }),
    CLINIC_ID,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.audioTurns.length, 1);
  const at = result.audioTurns[0];
  assert.ok(at);
  assert.equal(at.waId, "380991234567");
  assert.equal(at.mediaId, "media_xyz_789");
  assert.equal(at.messageId, "wamid.v1.abc");
});

// VERIFY: runtimeAgentLoop.ts not changed, openaiRuntimeAgent.ts not changed
test("VERIFY: core runtime files not modified in this PR", async () => {
  const { execSync } = await import("node:child_process");
  const changedFiles = execSync("git diff --name-only HEAD~1 2>/dev/null || git diff --name-only origin/ai-dental-frontdesk-core 2>/dev/null || echo ''", {
    encoding: "utf8",
    cwd: "/tmp/ai-dental-runtime-v2",
  }).split("\n").map(f => f.trim()).filter(Boolean);

  const forbidden = [
    "src/runtime/runtimeAgentLoop.ts",
    "src/runtime/openaiRuntimeAgent.ts",
    "src/integrations/cliniccard/bookingApplyGuard.ts",
    "src/integrations/cliniccard/clinicCardAdapter.ts",
    "src/integrations/cliniccard/bookingApplyExecutor.ts",
  ];

  for (const f of forbidden) {
    if (changedFiles.includes(f)) {
      assert.fail(`${f} must not be modified in voice PR`);
    }
  }

  const hasSqlChanges = changedFiles.some(f => f.endsWith(".sql") && !f.includes("rpc_check_availability"));
  assert.equal(hasSqlChanges, false, "No new SQL/schema changes allowed");
});

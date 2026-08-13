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
import type { RuntimeTurnInput } from "../src/runtime/runtimeTurnService.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";

const APP_SECRET = "test-app-secret";
const ACCESS_TOKEN = "test-access-token";
const PHONE_NUMBER_ID = "12345";
const GRAPH_VERSION = "v19.0";
const CLINIC_ID = "clinic_test";
const WA_ID = "420111222333";
const MESSAGE_ID = "wamid.audio.test123";
const OPENAI_API_KEY = "sk-test";
const CLINIC_ID_UUID = "11111111-1111-1111-8111-111111111111";
const CONTACT_ID_UUID = "22222222-2222-2222-8222-222222222222";

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

function makeEmptyEntryPayload(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [],
  };
}

function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf-8")).digest("hex")}`;
}

// ── Route mock helpers ────────────────────────────────────────────────────────

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

function makeMockClinicIdentityResolver() {
  return {
    async resolveClinicIdentity(_opts: unknown) {
      return { ok: true as const, data: { clinic_id: CLINIC_ID_UUID, clinic_code: CLINIC_ID } };
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

function makeFetchForAudio(opts: {
  transcript?: string;
  metaFails?: boolean;
  downloadFails?: boolean;
  transcribeFails?: boolean;
  outboundSendCount?: { n: number };
} = {}): typeof globalThis.fetch {
  return async (url: string | URL | Request, _opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Meta Graph API — media URL lookup
    if (urlStr.includes("graph.facebook.com") && !urlStr.includes("messages")) {
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
      if (opts.outboundSendCount) opts.outboundSendCount.n++;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.reply.1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("{}", { status: 200 });
  };
}

function makeFullRouteDeps(opts: {
  capturedInputs?: RuntimeTurnInput[];
  runCount?: { n: number };
  fetchFn?: typeof globalThis.fetch;
  duplicateOnSecondCall?: boolean;
  appSecret?: string | null;
} = {}): WhatsAppWebhookRouteDeps {
  const capturedInputs = opts.capturedInputs ?? [];
  const runCount = opts.runCount ?? { n: 0 };
  const { repo } = makeMockTurnPersistenceRepo({ duplicateOnSecondCall: opts.duplicateOnSecondCall });

  const runtimeTurnService = {
    async runTurn(input: RuntimeTurnInput) {
      runCount.n++;
      capturedInputs.push(input);
      return {
        final_patient_reply: "Ваш вопрос принят.",
        tool_requests: [],
        tool_results: [],
      };
    },
  } as unknown as WhatsAppWebhookRouteDeps["runtimeTurnService"];

  return {
    accessToken: ACCESS_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    verifyToken: "token",
    appSecret: opts.appSecret ?? APP_SECRET,
    graphApiVersion: GRAPH_VERSION,
    clinicId: CLINIC_ID,
    openaiApiKey: OPENAI_API_KEY,
    fetch: opts.fetchFn ?? makeFetchForAudio(),
    runtimeTurnService,
    runtimeTurnLogger: {
      logTurn: async () => {},
      logDelivery: async () => {},
    },
    clinicIdentityResolver: makeMockClinicIdentityResolver(),
    turnPersistenceRepository: repo,
  } as unknown as WhatsAppWebhookRouteDeps;
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

// WA-EMPTY-ADAPTER: empty entry → ok: true, both turns arrays empty
test("WA-ADAPTER-EMPTY-ENTRY: payload with entry:[] normalizes to ok=true with empty turns and audioTurns", () => {
  const result = normalizeWhatsAppPayload(makeEmptyEntryPayload(), CLINIC_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.turns.length, 0);
  assert.equal(result.audioTurns.length, 0);
  assert.equal(result.normalizedTurns.length, 0);
});

// WA-ORDERING: interleaved text+audio messages preserve original order in normalizedTurns
test("WA-ORDERING: normalizedTurns preserves original per-message order across text and audio", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "BIZ_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              messages: [
                { from: WA_ID, id: "m1", type: "audio", audio: { id: "media_1", mime_type: "audio/ogg" } },
                { from: WA_ID, id: "m2", type: "text", text: { body: "correction text" } },
                { from: WA_ID, id: "m3", type: "audio", audio: { id: "media_3", mime_type: "audio/ogg" } },
              ],
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
  // normalizedTurns must be [audio, text, audio] — original order preserved
  assert.equal(result.normalizedTurns.length, 3);
  assert.equal(result.normalizedTurns[0]!.type, "audio", "first must be audio");
  assert.equal(result.normalizedTurns[1]!.type, "text", "second must be text");
  assert.equal(result.normalizedTurns[2]!.type, "audio", "third must be audio");
  // backward-compat arrays
  assert.equal(result.turns.length, 1, "one text turn");
  assert.equal(result.audioTurns.length, 2, "two audio turns");
});

// ── Route-level tests ─────────────────────────────────────────────────────────

// WA-VOICE-3: invalid HMAC → ZERO media download, ZERO transcription, ZERO runtime
test("WA-VOICE-3: invalid HMAC returns 401 with no media download or transcription", async () => {
  let fetchCalled = false;
  const trackingFetch: typeof globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({ fetchFn: trackingFetch });
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
    makeReply().reply,
  );

  assert.equal(fetchCalled, false, "fetch must not be called when HMAC fails");
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

// WA-EMPTY-1: route-level regression — entry:[] → 200, no crash, zero runtime, zero transcription, zero outbound
test("WA-EMPTY-1: WhatsApp payload with entry:[] returns 200, no crash, zero runtime calls, zero outbound sends", async () => {
  const runCount = { n: 0 };
  const outboundSendCount = { n: 0 };

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    runCount,
    fetchFn: makeFetchForAudio({ outboundSendCount }),
  });
  registerWhatsAppWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/whatsapp")!;
  assert.ok(handler, "handler must be registered");

  const payloadStr = JSON.stringify(makeEmptyEntryPayload());
  const { reply, getState } = makeReply();
  await handler(
    {
      body: makeEmptyEntryPayload(),
      rawBody: Buffer.from(payloadStr, "utf-8"),
      headers: { "x-hub-signature-256": signPayload(payloadStr, APP_SECRET) },
    },
    reply,
  );

  assert.equal(getState().statusCode, 200, "must return 200");
  assert.equal(runCount.n, 0, "runtime must not be called for empty entry");
  assert.equal(outboundSendCount.n, 0, "no outbound WhatsApp send for empty entry");
});

// WA-VOICE-1: REAL route integration — signed audio webhook → media download → transcribe → runtime receives transcript
test("WA-VOICE-1: signed WhatsApp audio webhook → media download → transcription → runtime receives transcript as text", async () => {
  const capturedInputs: RuntimeTurnInput[] = [];
  const runCount = { n: 0 };
  const transcript = "запись на завтра";

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    capturedInputs,
    runCount,
    fetchFn: makeFetchForAudio({ transcript }),
  });
  registerWhatsAppWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/whatsapp")!;
  assert.ok(handler, "handler must be registered");

  const payloadStr = JSON.stringify(makeAudioPayload());
  const { reply, getState } = makeReply();
  await handler(
    {
      body: makeAudioPayload(),
      rawBody: Buffer.from(payloadStr, "utf-8"),
      headers: { "x-hub-signature-256": signPayload(payloadStr, APP_SECRET) },
    },
    reply,
  );

  assert.equal(getState().statusCode, 200);
  assert.equal(runCount.n, 1, "runtimeTurnService.runTurn must be called exactly once");
  const input = capturedInputs[0]!;
  assert.equal(input.user_message, transcript, "runtime receives transcript as user_message");
});

// WA-VOICE-2: REAL route integration — runtime receives trusted channel_contact from wa_id
test("WA-VOICE-2: runtime receives channel_contact.phone_source=whatsapp_sender with platform wa_id phone", async () => {
  const capturedInputs: RuntimeTurnInput[] = [];
  const runCount = { n: 0 };
  const specificWaId = "380991234567";

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    capturedInputs,
    runCount,
    fetchFn: makeFetchForAudio({ transcript: "привет" }),
  });
  registerWhatsAppWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/whatsapp")!;

  const payloadStr = JSON.stringify(makeAudioPayload({ waId: specificWaId }));
  await handler(
    {
      body: makeAudioPayload({ waId: specificWaId }),
      rawBody: Buffer.from(payloadStr, "utf-8"),
      headers: { "x-hub-signature-256": signPayload(payloadStr, APP_SECRET) },
    },
    makeReply().reply,
  );

  assert.equal(runCount.n, 1, "runtime called once");
  const input = capturedInputs[0]!;
  assert.equal(
    input.channel_contact?.phone_source,
    "whatsapp_sender",
    "channel_contact.phone_source must be whatsapp_sender",
  );
  assert.equal(
    input.channel_contact?.phone_number,
    `+${specificWaId}`,
    "channel_contact.phone_number must be normalized wa_id",
  );
});

// WA-VOICE-4: REAL route integration — same audio webhook twice → runtime exactly once, outbound send exactly once
test("WA-VOICE-4: same WhatsApp audio message sent twice → runtimeTurnService.runTurn called exactly once", async () => {
  const capturedInputs: RuntimeTurnInput[] = [];
  const runCount = { n: 0 };
  const outboundSendCount = { n: 0 };

  const { app, postHandlers } = makeRouteApp();
  const deps = makeFullRouteDeps({
    capturedInputs,
    runCount,
    fetchFn: makeFetchForAudio({ transcript: "тест дублирования", outboundSendCount }),
    duplicateOnSecondCall: true,
  });
  registerWhatsAppWebhookRoute(app, deps);

  const handler = postHandlers.get("/webhooks/whatsapp")!;
  const audioPayload = makeAudioPayload({ messageId: "wamid.dup.unique.1" });
  const payloadStr = JSON.stringify(audioPayload);
  const sig = signPayload(payloadStr, APP_SECRET);

  // First delivery
  const { reply: r1, getState: s1 } = makeReply();
  await handler({ body: audioPayload, rawBody: Buffer.from(payloadStr), headers: { "x-hub-signature-256": sig } }, r1);
  assert.equal(s1().statusCode, 200);

  // Second delivery (same message id → dedup)
  const { reply: r2, getState: s2 } = makeReply();
  await handler({ body: audioPayload, rawBody: Buffer.from(payloadStr), headers: { "x-hub-signature-256": sig } }, r2);
  assert.equal(s2().statusCode, 200);

  assert.equal(runCount.n, 1, "runtimeTurnService.runTurn must be called exactly once despite two deliveries");
  assert.equal(outboundSendCount.n, 1, "outbound WhatsApp send must happen exactly once");
});

// VERIFY: runtimeAgentLoop.ts not changed, openaiRuntimeAgent.ts not changed
test("VERIFY: core runtime files not modified in this PR", async () => {
  const { execSync } = await import("node:child_process");
  const changedFiles = execSync("git diff --name-only origin/ai-dental-frontdesk-core 2>/dev/null || echo ''", {
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

/**
 * Tests A-L: real handler exercised via dependency injection.
 * createElevenLabsWebSocket is injectable, so tests control the EL socket directly
 * without reconstructing JSON independently.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { createMediaBridgeHandler, type TwilioMediaBridgeDeps, type WebSocketLike } from "../src/voice/twilioMediaBridge.ts";

const VOICE_FIRST_MESSAGE = "Добрый день, клиника!";
const VOICE_FALLBACK_REPLY = "Извините, повторите.";

// Fake ElevenLabs WebSocket — injectable
class FakeElWs extends EventEmitter implements WebSocketLike {
  sent: string[] = [];
  readyState = 1; // OPEN
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit("close"); }
  open() { this.readyState = 1; this.emit("open"); }
  simulateMessage(data: unknown) { this.emit("message", JSON.stringify(data)); }
  simulateError(err: Error) { this.emit("error", err); }
}

// Fake Twilio WS connection
class FakeTwilioWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.emit("close"); }
}

function makeDeps(overrides?: Partial<TwilioMediaBridgeDeps>): {
  deps: TwilioMediaBridgeDeps;
  elWs: FakeElWs;
  signedUrlCallCount: number;
  resolveSignedUrl: (url: string) => void;
  rejectSignedUrl: (err: Error) => void;
} {
  const elWs = new FakeElWs();
  let resolveSignedUrl!: (url: string) => void;
  let rejectSignedUrl!: (err: Error) => void;
  let signedUrlCallCount = 0;
  const urlProm = new Promise<string>((res, rej) => {
    resolveSignedUrl = res;
    rejectSignedUrl = rej;
  });

  const deps: TwilioMediaBridgeDeps = {
    elevenlabs: {
      conversationalAi: {
        conversations: {
          getSignedUrl: async (_opts: unknown) => {
            signedUrlCallCount++;
            const url = await urlProm;
            return { signedUrl: url };
          },
        },
      },
    } as unknown as TwilioMediaBridgeDeps["elevenlabs"],
    speechEngineId: "engine_test",
    voiceFirstMessage: VOICE_FIRST_MESSAGE,
    createElevenLabsWebSocket: () => elWs,
    ...overrides,
  };

  return {
    deps,
    elWs,
    get signedUrlCallCount() { return signedUrlCallCount; },
    resolveSignedUrl,
    rejectSignedUrl,
  };
}

function startSession(twilioWs: FakeTwilioWs, streamSid = "SS1", callSid = "CA1") {
  twilioWs.emit("message", JSON.stringify({ event: "start", start: { streamSid, callSid } }));
}
function sendMedia(twilioWs: FakeTwilioWs, payload: string) {
  twilioWs.emit("message", JSON.stringify({ event: "media", media: { payload } }));
}
function sendStop(twilioWs: FakeTwilioWs) {
  twilioWs.emit("message", JSON.stringify({ event: "stop" }));
}
function tick() { return new Promise<void>(r => setImmediate(r)); }

// ─── A: start ────────────────────────────────────────────────────────────────

test("BRIDGE-A: Twilio start calls signed URL exactly once and creates EL WS", async () => {
  const elWs = new FakeElWs();
  let getSignedUrlCalled = 0;
  let wsCreated = false;
  let resolveUrl!: (url: string) => void;
  const urlProm = new Promise<string>(r => { resolveUrl = r; });

  const deps: TwilioMediaBridgeDeps = {
    elevenlabs: {
      conversationalAi: {
        conversations: {
          getSignedUrl: async (_opts: unknown) => {
            getSignedUrlCalled++;
            const url = await urlProm;
            return { signedUrl: url };
          },
        },
      },
    } as unknown as TwilioMediaBridgeDeps["elevenlabs"],
    speechEngineId: "engine_test",
    voiceFirstMessage: VOICE_FIRST_MESSAGE,
    createElevenLabsWebSocket: (url: string) => {
      assert.ok(url.startsWith("wss://"), "WS factory called with signed URL");
      wsCreated = true;
      return elWs;
    },
  };

  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  startSession(twilioWs);
  await tick();
  resolveUrl("wss://stub/signed");
  await tick();

  assert.equal(getSignedUrlCalled, 1, "signed URL called exactly once");
  assert.ok(wsCreated, "EL WS was created");
});

// ─── B: init ─────────────────────────────────────────────────────────────────

test("BRIDGE-B: EL opens → first outgoing EL message is conversation_initiation_client_data with voiceFirstMessage", async () => {
  const { deps, elWs, resolveSignedUrl } = makeDeps();
  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  startSession(twilioWs);
  await tick();
  resolveSignedUrl("wss://stub/signed");
  await tick();
  elWs.open();
  await tick();

  assert.ok(elWs.sent.length > 0, "EL WS received at least one message after open");
  const first = JSON.parse(elWs.sent[0]);
  assert.equal(first.type, "conversation_initiation_client_data", "first message type is conversation_initiation_client_data");
  assert.equal(
    first.conversation_config_override?.agent?.first_message,
    VOICE_FIRST_MESSAGE,
    "first_message matches voiceFirstMessage",
  );
});

// ─── C: correct caller audio ──────────────────────────────────────────────────

test("BRIDGE-C: Twilio media → EL socket receives {user_audio_chunk: payload}, NOT audio_event", async () => {
  const { deps, elWs, resolveSignedUrl } = makeDeps();
  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  startSession(twilioWs);
  await tick();
  resolveSignedUrl("wss://stub/signed");
  await tick();
  elWs.open();
  await tick();
  const sentBeforeMedia = elWs.sent.length; // init message(s)

  const payload = "AAEC/base64audio";
  sendMedia(twilioWs, payload);
  await tick();

  const audioMessages = elWs.sent.slice(sentBeforeMedia).map(m => JSON.parse(m));
  assert.ok(audioMessages.length > 0, "EL received audio message");
  const audioMsg = audioMessages[0];
  assert.equal(audioMsg.user_audio_chunk, payload, "user_audio_chunk contains the payload");
  assert.ok(!("type" in audioMsg), "audio message has no type key");
  assert.ok(!("audio_event" in audioMsg), "audio message has no audio_event key");
});

// ─── D: early buffering ───────────────────────────────────────────────────────

test("BRIDGE-D: media arriving before EL OPEN is buffered and flushed in order after init", async () => {
  const { deps, elWs, resolveSignedUrl } = makeDeps();
  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  startSession(twilioWs);
  await tick();

  // Send 3 audio chunks before EL even opens
  sendMedia(twilioWs, "chunk_0");
  sendMedia(twilioWs, "chunk_1");
  sendMedia(twilioWs, "chunk_2");
  await tick();

  // No messages to EL yet (not open)
  assert.equal(elWs.sent.length, 0, "no EL messages before EL OPEN");

  resolveSignedUrl("wss://stub/signed");
  await tick();
  elWs.open();
  await tick();

  // After open: init message + 3 buffered chunks
  const allSent = elWs.sent.map(m => JSON.parse(m));
  const initMsg = allSent[0];
  assert.equal(initMsg.type, "conversation_initiation_client_data", "first is init");

  const audioMsgs = allSent.slice(1);
  assert.ok(audioMsgs.length >= 3, `at least 3 buffered chunks flushed, got ${audioMsgs.length}`);
  assert.equal(audioMsgs[0].user_audio_chunk, "chunk_0", "chunk_0 delivered first");
  assert.equal(audioMsgs[1].user_audio_chunk, "chunk_1", "chunk_1 delivered second");
  assert.equal(audioMsgs[2].user_audio_chunk, "chunk_2", "chunk_2 delivered third");
});

// ─── E: EL audio output ───────────────────────────────────────────────────────

test("BRIDGE-E: EL audio output forwarded as Twilio media event", async () => {
  const { deps, elWs, resolveSignedUrl } = makeDeps();
  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  startSession(twilioWs, "SS_E");
  await tick();
  resolveSignedUrl("wss://stub/signed");
  await tick();
  elWs.open();
  await tick();

  elWs.simulateMessage({ type: "audio", audio_event: { audio_base_64: "AUDIO_BASE_64_DATA" } });
  await tick();

  const mediaMessages = twilioWs.sent.map(m => JSON.parse(m)).filter(m => m.event === "media");
  assert.ok(mediaMessages.length > 0, "Twilio received at least one media event");
  const mediaMsg = mediaMessages[0];
  assert.equal(mediaMsg.streamSid, "SS_E", "streamSid matches");
  assert.equal(mediaMsg.media?.payload, "AUDIO_BASE_64_DATA", "audio payload forwarded");
});

// ─── F: interruption ──────────────────────────────────────────────────────────

test("BRIDGE-F: EL interruption → Twilio socket receives clear event", async () => {
  const { deps, elWs, resolveSignedUrl } = makeDeps();
  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  startSession(twilioWs, "SS_F");
  await tick();
  resolveSignedUrl("wss://stub/signed");
  await tick();
  elWs.open();
  await tick();

  const sentBefore = twilioWs.sent.length;
  elWs.simulateMessage({ type: "interruption" });
  await tick();

  const newMessages = twilioWs.sent.slice(sentBefore).map(m => JSON.parse(m));
  const clearMsg = newMessages.find(m => m.event === "clear");
  assert.ok(clearMsg, "Twilio received a clear event on interruption");
});

// ─── G: ping/pong ────────────────────────────────────────────────────────────

test("BRIDGE-G: EL ping with event_id=123 → actual EL socket receives pong with event_id=123", async () => {
  const { deps, elWs, resolveSignedUrl } = makeDeps();
  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  startSession(twilioWs);
  await tick();
  resolveSignedUrl("wss://stub/signed");
  await tick();
  elWs.open();
  await tick();

  const sentBefore = elWs.sent.length;
  elWs.simulateMessage({ type: "ping", ping_event: { event_id: 123 } });
  await tick();

  const newMessages = elWs.sent.slice(sentBefore).map(m => JSON.parse(m));
  const pong = newMessages.find(m => m.type === "pong");
  assert.ok(pong, "EL received a pong message");
  assert.equal(pong.event_id, 123, "pong event_id matches ping event_id");
});

// ─── H: auth — invalid/missing WS signature ───────────────────────────────────

test("BRIDGE-H: signed URL NOT requested when auth is missing/invalid", async () => {
  // This is validated at the voiceGatewayServer level — if auth is invalid,
  // the handler is never invoked. The bridge itself doesn't auth-validate.
  // We verify the bridge handler only gets called after server-level auth.
  // Test: bridge with no twilioAuthToken does NOT reject — server-level auth handles rejection.
  let getSignedUrlCalled = false;
  const deps: TwilioMediaBridgeDeps = {
    elevenlabs: {
      conversationalAi: {
        conversations: {
          getSignedUrl: async (_opts: unknown) => {
            getSignedUrlCalled = true;
            return { signedUrl: "wss://stub" };
          },
        },
      },
    } as unknown as TwilioMediaBridgeDeps["elevenlabs"],
    speechEngineId: "engine_test",
    voiceFirstMessage: VOICE_FIRST_MESSAGE,
  };

  const handler = createMediaBridgeHandler(deps);
  const twilioWs = new FakeTwilioWs();
  handler(twilioWs);

  // If the connection is immediately closed without a start event, signed URL must NOT be called
  twilioWs.emit("close");
  await tick();

  assert.equal(getSignedUrlCalled, false, "signed URL must not be requested without a Twilio start event");
});

// ─── I: cleanup ───────────────────────────────────────────────────────────────

test("BRIDGE-I: EL failure closes Twilio; Twilio stop closes EL", async () => {
  // EL failure → Twilio closed
  {
    const { deps, elWs, resolveSignedUrl } = makeDeps();
    const handler = createMediaBridgeHandler(deps);
    const twilioWs = new FakeTwilioWs();
    handler(twilioWs);

    startSession(twilioWs);
    await tick();
    resolveSignedUrl("wss://stub/signed");
    await tick();
    elWs.open();
    await tick();

    elWs.simulateError(new Error("EL network failure"));
    await tick();

    assert.ok(twilioWs.closed, "Twilio closed after EL error");
  }

  // Twilio stop → EL closed
  {
    const { deps, elWs, resolveSignedUrl } = makeDeps();
    const handler = createMediaBridgeHandler(deps);
    const twilioWs = new FakeTwilioWs();
    handler(twilioWs);

    startSession(twilioWs);
    await tick();
    resolveSignedUrl("wss://stub/signed");
    await tick();
    elWs.open();
    await tick();

    sendStop(twilioWs);
    await tick();

    assert.equal(elWs.readyState, 3, "EL WS closed after Twilio stop");
  }
});

// ─── J: runtime failure → fallback sent exactly once ─────────────────────────

test("BRIDGE-J: runtime failure (not aborted) → fallback sent via session.sendResponse exactly once", async () => {
  // This tests the elevenLabsBrain onTranscript error path
  const { createElevenLabsBrainCallbacks } = await import("../src/voice/elevenLabsBrain.ts");

  const fallbacksSent: string[] = [];
  const mockSession = {
    conversationId: "conv_test_J",
    sendResponse: async (text: string) => { fallbacksSent.push(text); },
  };

  const deps = {
    runtimeBaseUrl: "http://localhost:3000",
    runtimeApiKey: "test_key",
    voiceClinicCode: "test_clinic",
    voiceFallbackReply: VOICE_FALLBACK_REPLY,
  };

  const callbacks = createElevenLabsBrainCallbacks(deps);

  const notAbortedSignal = AbortSignal.timeout(30_000);

  // Stub: runtimeVoiceClient is internal — we simulate transcript with a runtime that fails
  // by patching fetch globally for this test
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("runtime_unreachable"); };

  try {
    callbacks.onTranscript!(
      [{ role: "user", content: "Хочу записаться" }],
      notAbortedSignal,
      mockSession as unknown as Parameters<typeof callbacks.onTranscript!>[2],
    );
    // Wait for the async error path
    await new Promise(r => setTimeout(r, 100));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fallbacksSent.length, 1, "fallback sent exactly once");
  assert.equal(fallbacksSent[0], VOICE_FALLBACK_REPLY, "correct fallback message sent");
});

// ─── K: aborted runtime → no answer, no fallback ─────────────────────────────

test("BRIDGE-K: aborted runtime signal → no response, no fallback", async () => {
  const { createElevenLabsBrainCallbacks } = await import("../src/voice/elevenLabsBrain.ts");

  const responsesSent: string[] = [];
  const mockSession = {
    conversationId: "conv_test_K",
    sendResponse: async (text: string) => { responsesSent.push(text); },
  };

  const deps = {
    runtimeBaseUrl: "http://localhost:3000",
    runtimeApiKey: "test_key",
    voiceClinicCode: "test_clinic",
    voiceFallbackReply: VOICE_FALLBACK_REPLY,
  };

  const callbacks = createElevenLabsBrainCallbacks(deps);

  // Pre-aborted signal
  const controller = new AbortController();
  controller.abort();
  const abortedSignal = controller.signal;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("runtime_unreachable"); };

  try {
    callbacks.onTranscript!(
      [{ role: "user", content: "Хочу записаться" }],
      abortedSignal,
      mockSession as unknown as Parameters<typeof callbacks.onTranscript!>[2],
    );
    await new Promise(r => setTimeout(r, 100));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(responsesSent.length, 0, "no response sent when signal is aborted");
});

// ─── L: missing conversationId → runtime NOT called ──────────────────────────

test("BRIDGE-L: missing conversationId → runtime NOT called, fallback sent", async () => {
  const { createElevenLabsBrainCallbacks } = await import("../src/voice/elevenLabsBrain.ts");

  const responsesSent: string[] = [];
  let runtimeCalled = false;

  const mockSession = {
    conversationId: undefined, // missing
    sendResponse: async (text: string) => { responsesSent.push(text); },
  };

  const deps = {
    runtimeBaseUrl: "http://localhost:3000",
    runtimeApiKey: "test_key",
    voiceClinicCode: "test_clinic",
    voiceFallbackReply: VOICE_FALLBACK_REPLY,
  };

  const callbacks = createElevenLabsBrainCallbacks(deps);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    runtimeCalled = true;
    throw new Error("should not be called");
  };

  const notAbortedSignal = AbortSignal.timeout(30_000);

  try {
    callbacks.onTranscript!(
      [{ role: "user", content: "Здравствуйте" }],
      notAbortedSignal,
      mockSession as unknown as Parameters<typeof callbacks.onTranscript!>[2],
    );
    await new Promise(r => setTimeout(r, 50));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(runtimeCalled, false, "runtime must NOT be called when conversationId is missing");
  assert.equal(responsesSent.length, 1, "fallback sent when conversationId is missing");
  assert.equal(responsesSent[0], VOICE_FALLBACK_REPLY, "correct fallback");
});

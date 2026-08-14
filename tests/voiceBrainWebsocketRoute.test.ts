import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createElevenLabsBrainWebsocketHandler,
  wireElevenLabsBrainCallbacks,
} from "../src/voice/elevenLabsBrainWebsocket.ts";

function makeSocket() {
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
  };
  return { socket, closes };
}

class FakeSession extends EventEmitter {
  conversationId: string | undefined;

  override on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    return this;
  }
}

test("VOICE-BRAIN-1: gateway owns /voice/brain as a Fastify websocket route, not engine.attach", () => {
  const source = readFileSync(new URL("../src/voice/voiceGatewayServer.ts", import.meta.url), "utf8");

  assert.match(source, /["']\/voice\/brain["']/);
  assert.match(source, /websocket:\s*true/);
  assert.doesNotMatch(source, /\.attach\s*\(/, "must not add a competing HTTP upgrade listener");
});

test("VOICE-BRAIN-2: engine-not-ready connection is rejected fail-closed", async () => {
  const { socket, closes } = makeSocket();
  const handler = createElevenLabsBrainWebsocketHandler({
    getEngine: () => null,
    callbacks: {},
  });

  await handler(socket as never, { headers: {} } as never);

  assert.deepEqual(closes, [{ code: 1013, reason: "Speech Engine not ready" }]);
});

test("VOICE-BRAIN-3: missing/invalid ElevenLabs auth is rejected and no session is created", async () => {
  const { socket, closes } = makeSocket();
  let createSessionCalled = false;
  const handler = createElevenLabsBrainWebsocketHandler({
    getEngine: () => ({
      async verifyRequest() { return false; },
      createSession() {
        createSessionCalled = true;
        return new FakeSession() as never;
      },
    }) as never,
    callbacks: {},
  });

  await handler(socket as never, { headers: {} } as never);

  assert.equal(createSessionCalled, false);
  assert.deepEqual(closes, [{ code: 1008, reason: "Unauthorized" }]);
});

test("VOICE-BRAIN-4: verification exceptions fail closed without creating a session", async () => {
  const { socket, closes } = makeSocket();
  let createSessionCalled = false;
  const handler = createElevenLabsBrainWebsocketHandler({
    getEngine: () => ({
      async verifyRequest() { throw new Error("bad jwt"); },
      createSession() {
        createSessionCalled = true;
        return new FakeSession() as never;
      },
    }) as never,
    callbacks: {},
  });

  await handler(socket as never, { headers: {} } as never);

  assert.equal(createSessionCalled, false);
  assert.deepEqual(closes, [{ code: 1008, reason: "Unauthorized" }]);
});

test("VOICE-BRAIN-5: verified request creates a session and forwards init + transcript", async () => {
  const { socket, closes } = makeSocket();
  const session = new FakeSession();
  const seen: string[] = [];
  let verifiedHeaders: Record<string, string | string[] | undefined> | undefined;

  const handler = createElevenLabsBrainWebsocketHandler({
    getEngine: () => ({
      async verifyRequest(req) {
        verifiedHeaders = req.headers;
        return true;
      },
      createSession() { return session as never; },
    }) as never,
    callbacks: {
      onInit(conversationId) {
        seen.push(`init:${conversationId}`);
      },
      onTranscript(transcript, signal) {
        assert.equal(signal.aborted, false);
        seen.push(`transcript:${transcript.at(-1)?.content}`);
      },
    },
  });

  const auth = "Bearer signed-elevenlabs-jwt";
  await handler(socket as never, {
    headers: { "x-elevenlabs-speech-engine-authorization": auth },
  } as never);

  assert.equal(verifiedHeaders?.["x-elevenlabs-speech-engine-authorization"], auth);
  assert.equal(closes.length, 0);

  session.emit("init", "conv_voice_1");
  const ac = new AbortController();
  session.emit("user_transcript", [{ role: "user", content: "Здравствуйте" }], ac.signal);

  assert.deepEqual(seen, ["init:conv_voice_1", "transcript:Здравствуйте"]);
});

test("VOICE-BRAIN-6: callback wiring forwards close/disconnect/error and async transcript errors", async () => {
  const session = new FakeSession();
  const seen: string[] = [];

  wireElevenLabsBrainCallbacks(session as never, {
    onTranscript: async () => {
      throw new Error("runtime callback failed");
    },
    onClose: () => { seen.push("close"); },
    onDisconnect: () => { seen.push("disconnect"); },
    onError: (error) => { seen.push(`error:${error.message}`); },
  });

  session.emit("close");
  session.emit("disconnected");
  session.emit("error", new Error("wire error"));
  session.emit(
    "user_transcript",
    [{ role: "user", content: "test" }],
    new AbortController().signal,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(seen, [
    "close",
    "disconnect",
    "error:wire error",
    "error:runtime callback failed",
  ]);
});

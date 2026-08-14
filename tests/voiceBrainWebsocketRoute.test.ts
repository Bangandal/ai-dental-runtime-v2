import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createElevenLabsBrainPreValidation,
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

function makeReply() {
  let statusCode = 200;
  const bodies: unknown[] = [];
  const reply = {
    code(code: number) {
      statusCode = code;
      return reply;
    },
    send(body: unknown) {
      bodies.push(body);
      return reply;
    },
  };
  return {
    reply,
    get statusCode() { return statusCode; },
    bodies,
  };
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
  assert.match(source, /preValidation:\s*createElevenLabsBrainPreValidation/);
  assert.doesNotMatch(source, /\.attach\s*\(/, "must not add a competing HTTP upgrade listener");
});

test("VOICE-BRAIN-2: engine-not-ready request is rejected with HTTP 503 before websocket upgrade", async () => {
  const state = makeReply();
  const validate = createElevenLabsBrainPreValidation({
    getEngine: () => null,
    callbacks: {},
  });

  await validate({ headers: {} } as never, state.reply as never);

  assert.equal(state.statusCode, 503);
  assert.deepEqual(state.bodies, [{ ok: false, error: "speech_engine_not_ready" }]);
});

test("VOICE-BRAIN-3: missing/invalid ElevenLabs auth is rejected fail-closed before upgrade", async () => {
  const state = makeReply();
  const validate = createElevenLabsBrainPreValidation({
    getEngine: () => ({
      async verifyRequest() { return false; },
      createSession() { throw new Error("must not create session during preValidation"); },
    }) as never,
    callbacks: {},
  });

  await validate({ headers: {} } as never, state.reply as never);

  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.bodies, [{ ok: false, error: "unauthorized" }]);
});

test("VOICE-BRAIN-4: verification exceptions fail closed with HTTP 401", async () => {
  const state = makeReply();
  const validate = createElevenLabsBrainPreValidation({
    getEngine: () => ({
      async verifyRequest() { throw new Error("bad jwt"); },
      createSession() { throw new Error("must not create session during preValidation"); },
    }) as never,
    callbacks: {},
  });

  await validate({ headers: {} } as never, state.reply as never);

  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.bodies, [{ ok: false, error: "unauthorized" }]);
});

test("VOICE-BRAIN-5: verified request creates session synchronously and forwards init + transcript", async () => {
  const session = new FakeSession();
  const seen: string[] = [];
  let verifiedHeaders: Record<string, string | string[] | undefined> | undefined;
  let createSessionCalled = false;

  const engine = {
    async verifyRequest(req: { headers: Record<string, string | string[] | undefined> }) {
      verifiedHeaders = req.headers;
      return true;
    },
    createSession() {
      createSessionCalled = true;
      return session as never;
    },
  };
  const deps = {
    getEngine: () => engine as never,
    callbacks: {
      onInit(conversationId: string) {
        seen.push(`init:${conversationId}`);
      },
      onTranscript(transcript: Array<{ role: "user" | "agent"; content: string }>, signal: AbortSignal) {
        assert.equal(signal.aborted, false);
        seen.push(`transcript:${transcript.at(-1)?.content}`);
      },
    },
  };

  const auth = "Bearer signed-elevenlabs-jwt";
  const state = makeReply();
  const validate = createElevenLabsBrainPreValidation(deps as never);
  await validate({
    headers: { "x-elevenlabs-speech-engine-authorization": auth },
  } as never, state.reply as never);

  assert.equal(state.bodies.length, 0, "valid preValidation must allow websocket upgrade");
  assert.equal(verifiedHeaders?.["x-elevenlabs-speech-engine-authorization"], auth);

  const { socket, closes } = makeSocket();
  const handler = createElevenLabsBrainWebsocketHandler(deps as never);
  handler(socket as never);

  assert.equal(createSessionCalled, true);
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

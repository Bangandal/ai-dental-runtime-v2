import assert from "node:assert/strict";
import test from "node:test";

import { createElevenLabsBrainCallbacks } from "../src/voice/elevenLabsBrain.ts";
import type { RuntimeVoiceClientDeps } from "../src/voice/runtimeVoiceClient.ts";

const FALLBACK_MESSAGE = "Извините, сейчас не удалось обработать запрос.";

function makeDeps() {
  const runtimeDeps: RuntimeVoiceClientDeps & { voiceClinicCode: string; voiceFallbackReply: string } = {
    runtimeBaseUrl: "https://rt.example.com",
    runtimeApiKey: "key",
    voiceClinicCode: "clinic_1",
    voiceFallbackReply: FALLBACK_MESSAGE,
  };
  return { runtimeDeps };
}

function makeSession(conversationId?: string) {
  const responses: string[] = [];
  const session = {
    conversationId: conversationId,
    sendResponse(text: string) { responses.push(text); return Promise.resolve(); },
    close() {},
    isOpen: true,
    on() { return session; },
    off() { return session; },
    once() { return session; },
  };
  return { session, responses };
}

test("elevenLabsBrain: onInit does NOT send first message (greeting via initiation data)", () => {
  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession();

  callbacks.onInit!("conv_abc", session as never);
  // Greeting must NOT come from onInit — it's sent via conversation_initiation_client_data
  assert.equal(responses.length, 0, "onInit must not call session.sendResponse for greeting");
});

test("elevenLabsBrain: onTranscript calls runtime and sends reply", async () => {
  const { runtimeDeps } = makeDeps();

  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ final_patient_reply: "Записал" }), { status: 200 });

  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession("conv_1");
  const ac = new AbortController();

  callbacks.onTranscript!(
    [{ role: "user", content: "Запишите меня" }],
    ac.signal,
    session as never,
  );

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(responses[0], "Записал");
  globalThis.fetch = orig;
});

test("elevenLabsBrain: aborted signal suppresses response", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ final_patient_reply: "Too late" }), { status: 200 });
  };

  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession("conv_2");
  const ac = new AbortController();

  callbacks.onTranscript!(
    [{ role: "user", content: "Хочу записаться" }],
    ac.signal,
    session as never,
  );

  ac.abort();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(responses.length, 0);

  globalThis.fetch = orig;
});

test("elevenLabsBrain: empty transcript is no-op", async () => {
  const orig = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return new Response("{}", { status: 200 }); };

  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession();
  const ac = new AbortController();

  callbacks.onTranscript!([], ac.signal, session as never);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(responses.length, 0);
  assert.equal(fetchCalled, false);
  globalThis.fetch = orig;
});

test("elevenLabsBrain: agent-only transcript is no-op", async () => {
  const orig = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return new Response("{}", { status: 200 }); };

  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession();
  const ac = new AbortController();

  callbacks.onTranscript!(
    [{ role: "agent", content: "Чем могу помочь?" }],
    ac.signal,
    session as never,
  );
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(responses.length, 0);
  assert.equal(fetchCalled, false);
  globalThis.fetch = orig;
});

test("elevenLabsBrain: runtime failure sends fallback reply when not aborted", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("runtime_unreachable"); };

  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession("conv_3");
  const ac = new AbortController();

  callbacks.onTranscript!(
    [{ role: "user", content: "Хочу записаться" }],
    ac.signal,
    session as never,
  );

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(responses.length, 1, "exactly one fallback sent");
  assert.equal(responses[0], FALLBACK_MESSAGE);
  globalThis.fetch = orig;
});

test("elevenLabsBrain: missing conversationId skips runtime, sends fallback", async () => {
  let fetchCalled = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error("should not be called"); };

  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession(); // no conversationId — session.conversationId is undefined
  const ac = new AbortController();

  callbacks.onTranscript!(
    [{ role: "user", content: "Здравствуйте" }],
    ac.signal,
    session as never,
  );

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fetchCalled, false, "runtime must not be called when conversationId is absent");
  assert.equal(responses.length, 1, "fallback must be sent");
  assert.equal(responses[0], FALLBACK_MESSAGE);
  globalThis.fetch = orig;
});

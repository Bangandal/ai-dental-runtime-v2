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
    conversationId,
    sendResponse(text: string) { responses.push(text); return Promise.resolve(); },
    close() {},
    isOpen: true,
    on() { return session; },
    off() { return session; },
    once() { return session; },
  };
  return { session, responses };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("elevenLabsBrain: onInit does NOT send first message", () => {
  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession();

  callbacks.onInit!("conv_abc", session as never);
  assert.equal(responses.length, 0);
});

test("elevenLabsBrain: onTranscript calls runtime and sends reply", async () => {
  const { runtimeDeps } = makeDeps();
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ final_patient_reply: "Записал" }), { status: 200 });

  try {
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession("conv_1");

    callbacks.onTranscript!(
      [{ role: "user", content: "Запишите меня" }],
      new AbortController().signal,
      session as never,
    );

    await sleep(30);
    assert.deepEqual(responses, ["Записал"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: duplicate protocol event does not restart an in-flight Runtime turn", async () => {
  const { runtimeDeps } = makeDeps();
  const orig = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    fetchCount += 1;
    await sleep(25);
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response(JSON.stringify({ final_patient_reply: "Цены готовы" }), { status: 200 });
  };

  try {
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession("conv_dup_inflight");
    const firstSdkEvent = new AbortController();

    callbacks.onTranscript!(
      [{ role: "user", content: "Какие цены?" }],
      firstSdkEvent.signal,
      session as never,
    );

    // This mirrors SpeechEngineSession: a newer protocol event aborts the old
    // SDK signal before invoking onTranscript again. It must not cancel the
    // business call when the full history still contains the same user turn.
    firstSdkEvent.abort();
    callbacks.onTranscript!(
      [{ role: "user", content: "Какие цены?" }],
      new AbortController().signal,
      session as never,
    );

    await sleep(60);
    assert.equal(fetchCount, 1, "same semantic user turn must call Runtime once");
    assert.deepEqual(responses, ["Цены готовы"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: duplicate after Runtime reply rebinds cached reply without a second call", async () => {
  const { runtimeDeps } = makeDeps();
  const orig = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ final_patient_reply: "1 500 Kč" }), { status: 200 });
  };

  try {
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession("conv_dup_cached");

    callbacks.onTranscript!(
      [{ role: "user", content: "Цена консультации?" }],
      new AbortController().signal,
      session as never,
    );
    await sleep(20);

    callbacks.onTranscript!(
      [
        { role: "agent", content: "Чем могу помочь?" },
        { role: "user", content: "Цена консультации?" },
      ],
      new AbortController().signal,
      session as never,
    );
    await sleep(10);

    assert.equal(fetchCount, 1);
    assert.deepEqual(responses, ["1 500 Kč", "1 500 Kč"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: genuinely new user turn aborts old Runtime call and starts a new one", async () => {
  const { runtimeDeps } = makeDeps();
  const orig = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    fetchCount += 1;
    const call = fetchCount;
    if (call === 1) {
      await sleep(35);
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response(JSON.stringify({ final_patient_reply: "old" }), { status: 200 });
    }
    return new Response(JSON.stringify({ final_patient_reply: "new" }), { status: 200 });
  };

  try {
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession("conv_new_turn");

    callbacks.onTranscript!(
      [{ role: "user", content: "Какие цены?" }],
      new AbortController().signal,
      session as never,
    );

    await sleep(5);
    callbacks.onTranscript!(
      [
        { role: "user", content: "Какие цены?" },
        { role: "agent", content: "Уточните услугу" },
        { role: "user", content: "Отбеливание" },
      ],
      new AbortController().signal,
      session as never,
    );

    await sleep(70);
    assert.equal(fetchCount, 2);
    assert.deepEqual(responses, ["new"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: repeated identical words in a NEW user turn still call Runtime", async () => {
  const { runtimeDeps } = makeDeps();
  const orig = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ final_patient_reply: `reply-${fetchCount}` }), { status: 200 });
  };

  try {
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession("conv_repeat_words");

    callbacks.onTranscript!(
      [{ role: "user", content: "Да" }],
      new AbortController().signal,
      session as never,
    );
    await sleep(10);

    callbacks.onTranscript!(
      [
        { role: "user", content: "Да" },
        { role: "agent", content: "Продолжить?" },
        { role: "user", content: "Да" },
      ],
      new AbortController().signal,
      session as never,
    );
    await sleep(20);

    assert.equal(fetchCount, 2);
    assert.deepEqual(responses, ["reply-1", "reply-2"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: empty transcript is no-op", async () => {
  const orig = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return new Response("{}", { status: 200 }); };

  try {
    const { runtimeDeps } = makeDeps();
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession();

    callbacks.onTranscript!([], new AbortController().signal, session as never);
    await sleep(10);

    assert.equal(responses.length, 0);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: agent-only transcript is no-op", async () => {
  const orig = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return new Response("{}", { status: 200 }); };

  try {
    const { runtimeDeps } = makeDeps();
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession();

    callbacks.onTranscript!(
      [{ role: "agent", content: "Чем могу помочь?" }],
      new AbortController().signal,
      session as never,
    );
    await sleep(10);

    assert.equal(responses.length, 0);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: runtime failure sends one fallback reply", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("runtime_unreachable"); };

  try {
    const { runtimeDeps } = makeDeps();
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession("conv_3");

    callbacks.onTranscript!(
      [{ role: "user", content: "Хочу записаться" }],
      new AbortController().signal,
      session as never,
    );

    await sleep(30);
    assert.deepEqual(responses, [FALLBACK_MESSAGE]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("elevenLabsBrain: missing conversationId skips runtime and sends fallback", async () => {
  let fetchCalled = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error("should not be called"); };

  try {
    const { runtimeDeps } = makeDeps();
    const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
    const { session, responses } = makeSession();

    callbacks.onTranscript!(
      [{ role: "user", content: "Здравствуйте" }],
      new AbortController().signal,
      session as never,
    );

    await sleep(10);
    assert.equal(fetchCalled, false);
    assert.deepEqual(responses, [FALLBACK_MESSAGE]);
  } finally {
    globalThis.fetch = orig;
  }
});

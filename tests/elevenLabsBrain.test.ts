import assert from "node:assert/strict";
import test from "node:test";

import { createElevenLabsBrainCallbacks } from "../src/voice/elevenLabsBrain.ts";
import type { RuntimeVoiceClientDeps } from "../src/voice/runtimeVoiceClient.ts";

const FIRST_MESSAGE = "Добрый день. Стоматологическая клиника, чем могу помочь?";

function makeDeps(replyWith = "Записал вас") {
  const calls: { clinicCode: string; transcript: string }[] = [];
  const runtimeDeps: RuntimeVoiceClientDeps & { voiceClinicCode: string; voiceFirstMessage: string } = {
    runtimeBaseUrl: "https://rt.example.com",
    runtimeApiKey: "key",
    voiceClinicCode: "clinic_1",
    voiceFirstMessage: FIRST_MESSAGE,
  };

  const mockClient = {
    callRuntimeTurn: async (req: { clinicCode: string; patientTranscript: string; signal: AbortSignal }) => {
      if (req.signal.aborted) throw new DOMException("Aborted", "AbortError");
      calls.push({ clinicCode: req.clinicCode, transcript: req.patientTranscript });
      return { reply: replyWith };
    },
  };

  return { runtimeDeps, mockClient, calls };
}

function makeSession(conversationId = "conv_abc") {
  const responses: string[] = [];
  const session = {
    conversationId,
    sendResponse(text: string) { responses.push(text); },
    close() {},
    isOpen: true,
    on() { return session; },
    off() { return session; },
    once() { return session; },
  };
  return { session, responses };
}

test("elevenLabsBrain: onInit sends first message", () => {
  const { runtimeDeps } = makeDeps();
  const callbacks = createElevenLabsBrainCallbacks(runtimeDeps);
  const { session, responses } = makeSession();

  callbacks.onInit!("conv_abc", session as never);
  assert.equal(responses[0], FIRST_MESSAGE);
});

test("elevenLabsBrain: onTranscript calls runtime and sends reply", async () => {
  const { runtimeDeps, calls } = makeDeps("Записал");

  // Override createRuntimeVoiceClient behaviour by patching fetch
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

  // Wait for async runtime call to complete
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(responses[0], "Записал");
  globalThis.fetch = orig;
  void calls; // suppress unused warning
});

test("elevenLabsBrain: aborted signal suppresses response", async () => {
  const orig = globalThis.fetch;
  // Simulate slow runtime that finishes after signal is aborted
  globalThis.fetch = async (_url: string, init?: RequestInit) => {
    // Respect abort signal
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

  // Abort before runtime finishes
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

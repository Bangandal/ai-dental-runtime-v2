import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeVoiceClient } from "../src/voice/runtimeVoiceClient.ts";

const deps = { runtimeBaseUrl: "https://runtime.example.com", runtimeApiKey: "test-key" };
const client = createRuntimeVoiceClient(deps);

function baseReq(overrides: Partial<Parameters<typeof client.callRuntimeTurn>[0]> = {}) {
  return {
    clinicCode: "clinic_1",
    conversationId: "conv_123",
    patientTranscript: "Хочу записаться",
    turnNumber: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("voiceRuntimeClient: success with final_patient_reply", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ final_patient_reply: "Привет" }), { status: 200 });
  try {
    const result = await client.callRuntimeTurn(baseReq());
    assert.equal(result.reply, "Привет");
  } finally {
    globalThis.fetch = orig;
  }
});

test("voiceRuntimeClient: fallback to reply_text", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ reply_text: "OK" }), { status: 200 });
  try {
    const result = await client.callRuntimeTurn(baseReq());
    assert.equal(result.reply, "OK");
  } finally {
    globalThis.fetch = orig;
  }
});

test("voiceRuntimeClient: non-2xx throws", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("Internal error", { status: 500 });
  try {
    await assert.rejects(() => client.callRuntimeTurn(baseReq()), /500/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("voiceRuntimeClient: pre-aborted signal causes fetch to reject", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response(JSON.stringify({ final_patient_reply: "hi" }), { status: 200 });
  };
  try {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => client.callRuntimeTurn(baseReq({ signal: ac.signal })));
  } finally {
    globalThis.fetch = orig;
  }
});

test("voiceRuntimeClient: sends correct request body fields", async () => {
  const orig = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = url.toString();
    capturedBody = JSON.parse(init?.body as string);
    capturedAuth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
    return new Response(JSON.stringify({ final_patient_reply: "ok" }), { status: 200 });
  };
  try {
    await client.callRuntimeTurn(baseReq({ conversationId: "cv1", turnNumber: 3 }));
    assert.equal(capturedUrl, "https://runtime.example.com/runtime/turn");
    assert.equal(capturedBody.channel, "voice");
    assert.equal(capturedBody.external_user_id, "elevenlabs:cv1");
    assert.equal(capturedBody.chat_id, "elevenlabs:cv1");
    assert.equal(capturedBody.clinic_code, "clinic_1");
    const meta = capturedBody.meta as Record<string, string>;
    assert.equal(meta.message_id, "cv1:3");
    assert.equal(meta.update_id, "cv1:3");
    assert.equal(meta.input_modality, "realtime_voice");
    assert.equal(meta.voice_provider, "elevenlabs");
    assert.equal(capturedAuth, "Bearer test-key");
  } finally {
    globalThis.fetch = orig;
  }
});

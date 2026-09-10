import assert from "node:assert/strict";
import test from "node:test";

import {
  createVoiceTrustedContactToken,
  readVoiceTrustedContactToken,
} from "../src/runtime/voiceTrustedContactToken.ts";
import { createRuntimeVoiceClient } from "../src/voice/runtimeVoiceClient.ts";

const runtimeApiKey = "runtime-test-key-with-enough-entropy-for-tests";
const context = {
  clinicCode: "clinic_1",
  conversationId: "conv_123",
  callSid: "CA123",
  messageId: "conv_123:1",
};

test("voiceTrustedContactToken: round-trips E.164 caller id without plaintext leakage", () => {
  const phone = "+420700000001";
  const token = createVoiceTrustedContactToken({ runtimeApiKey, phoneNumber: phone, context });
  assert.ok(token);
  assert.doesNotMatch(token, /420700000001/);
  assert.equal(readVoiceTrustedContactToken({ runtimeApiKey, token, context }), phone);
});

test("voiceTrustedContactToken: tampering or context transplant fails closed", () => {
  const token = createVoiceTrustedContactToken({
    runtimeApiKey,
    phoneNumber: "+420700000001",
    context,
  });
  assert.ok(token);

  const tampered = `${token!.slice(0, -1)}${token!.endsWith("A") ? "B" : "A"}`;
  assert.equal(readVoiceTrustedContactToken({ runtimeApiKey, token: tampered, context }), null);
  assert.equal(readVoiceTrustedContactToken({
    runtimeApiKey,
    token,
    context: { ...context, callSid: "CA999" },
  }), null);
  assert.equal(readVoiceTrustedContactToken({
    runtimeApiKey: "wrong-key",
    token,
    context,
  }), null);
});

test("voiceTrustedContactToken: refuses non-E.164 caller ids", () => {
  assert.equal(createVoiceTrustedContactToken({
    runtimeApiKey,
    phoneNumber: "anonymous",
    context,
  }), null);
});

test("voiceRuntimeClient: sends caller only as authenticated opaque token", async () => {
  const client = createRuntimeVoiceClient({
    runtimeBaseUrl: "https://runtime.example.com",
    runtimeApiKey,
    voiceIdentityHmacSecret: "12345678901234567890123456789012",
  });
  const originalFetch = globalThis.fetch;
  let capturedBody = "";

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ final_patient_reply: "ok" }), { status: 200 });
  };

  try {
    await client.callRuntimeTurn({
      clinicCode: context.clinicCode,
      conversationId: context.conversationId,
      patientTranscript: "Запишите меня",
      turnNumber: 1,
      signal: new AbortController().signal,
      callContext: {
        callSid: context.callSid,
        streamSid: "MZ123",
        callerPhone: "+420700000001",
        calledNumber: "+420700000002",
        startedAt: Date.now(),
      },
    });

    assert.doesNotMatch(capturedBody, /\+420700000001/);
    assert.doesNotMatch(capturedBody, /\+420700000002/);

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    const token = body.voice_contact_token;
    assert.equal(typeof token, "string");
    assert.equal(readVoiceTrustedContactToken({ runtimeApiKey, token, context }), "+420700000001");
    const meta = body.meta as Record<string, unknown>;
    assert.equal(meta.twilio_call_sid, context.callSid);
    assert.equal(meta.voice_conversation_id, context.conversationId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

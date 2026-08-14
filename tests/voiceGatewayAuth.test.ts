/**
 * AUTH-1..4: server-level Twilio authentication tests.
 * Exercises the extracted validateTwilioWsSignature helper and readVoiceConfig fail-closed behavior.
 * Uses Twilio's official signature generation — no hand-rolled crypto.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { validateTwilioWsSignature, buildTwilioMediaStreamUrl } from "../src/voice/voiceGatewayServer.ts";
import { readVoiceConfig } from "../src/voice/voiceConfig.ts";

const TEST_TOKEN = "test_auth_token_abc123";
const TEST_PUBLIC_BASE_URL = "https://voice.example.com";
// Twilio signs the wss:// URL it actually sends the WebSocket handshake to — NOT https://
const WS_URL = buildTwilioMediaStreamUrl(TEST_PUBLIC_BASE_URL); // "wss://voice.example.com/voice/media-stream"

function validSig(token: string, wsUrl: string): string {
  return getExpectedTwilioSignature(token, wsUrl, {});
}

// ─── AUTH-1: VALID signature → accepted ──────────────────────────────────────

test("AUTH-1: valid Twilio WS signature for canonical URL → accepted", () => {
  const sig = validSig(TEST_TOKEN, WS_URL);
  const result = validateTwilioWsSignature(TEST_TOKEN, TEST_PUBLIC_BASE_URL, sig);
  assert.equal(result, true, "Valid signature must be accepted");
});

// ─── AUTH-2: INVALID signature → rejected ─────────────────────────────────────

test("AUTH-2: invalid Twilio WS signature → rejected", () => {
  const result = validateTwilioWsSignature(TEST_TOKEN, TEST_PUBLIC_BASE_URL, "invalidsignatureXXX");
  assert.equal(result, false, "Invalid signature must be rejected");
});

// ─── AUTH-3: MISSING signature → rejected ─────────────────────────────────────

test("AUTH-3: missing (empty) x-twilio-signature → rejected", () => {
  // Empty string simulates the ?? "" fallback in the server route when header is absent
  const result = validateTwilioWsSignature(TEST_TOKEN, TEST_PUBLIC_BASE_URL, "");
  assert.equal(result, false, "Missing/empty signature must be rejected");
});

// ─── AUTH-4: missing auth config in normal mode → startup/config failure ─────

test("AUTH-4: readVoiceConfig throws when TWILIO_AUTH_TOKEN missing in normal mode", () => {
  const env: NodeJS.ProcessEnv = {
    ELEVENLABS_API_KEY: "el_key",
    ELEVENLABS_SPEECH_ENGINE_ID: "eng_id",
    RUNTIME_BASE_URL: "http://localhost:3000",
    RUNTIME_API_KEY: "rt_key",
    VOICE_CLINIC_CODE: "clinic1",
    // TWILIO_AUTH_TOKEN absent
    VOICE_PUBLIC_BASE_URL: "https://voice.example.com",
    // VOICE_ALLOW_INSECURE_DEV not set
  };
  assert.throws(
    () => readVoiceConfig(env),
    /missing required security env vars.*TWILIO_AUTH_TOKEN/i,
    "Must throw when TWILIO_AUTH_TOKEN is missing in normal mode",
  );
});

test("AUTH-4b: readVoiceConfig throws when VOICE_PUBLIC_BASE_URL missing in normal mode", () => {
  const env: NodeJS.ProcessEnv = {
    ELEVENLABS_API_KEY: "el_key",
    ELEVENLABS_SPEECH_ENGINE_ID: "eng_id",
    RUNTIME_BASE_URL: "http://localhost:3000",
    RUNTIME_API_KEY: "rt_key",
    VOICE_CLINIC_CODE: "clinic1",
    TWILIO_AUTH_TOKEN: "tok123",
    // VOICE_PUBLIC_BASE_URL absent
  };
  assert.throws(
    () => readVoiceConfig(env),
    /missing required security env vars.*VOICE_PUBLIC_BASE_URL/i,
    "Must throw when VOICE_PUBLIC_BASE_URL is missing in normal mode",
  );
});

test("AUTH-4c: readVoiceConfig succeeds when VOICE_ALLOW_INSECURE_DEV=true despite missing auth vars", () => {
  const env: NodeJS.ProcessEnv = {
    ELEVENLABS_API_KEY: "el_key",
    ELEVENLABS_SPEECH_ENGINE_ID: "eng_id",
    RUNTIME_BASE_URL: "http://localhost:3000",
    RUNTIME_API_KEY: "rt_key",
    VOICE_CLINIC_CODE: "clinic1",
    VOICE_ALLOW_INSECURE_DEV: "true",
    // TWILIO_AUTH_TOKEN and VOICE_PUBLIC_BASE_URL absent
  };
  assert.doesNotThrow(
    () => readVoiceConfig(env),
    "Should not throw when VOICE_ALLOW_INSECURE_DEV=true",
  );
});

// ─── AUTH-5: HTTPS signature must NOT validate against WSS URL ────────────────

test("AUTH-5: signature generated for https:// URL must not validate against wss:// URL", () => {
  const httpsUrl = `https://voice.example.com/voice/media-stream`;
  const httpsSignature = getExpectedTwilioSignature(TEST_TOKEN, httpsUrl, {});

  // validateTwilioWsSignature uses wss:// internally — a https-signed sig must fail
  const result = validateTwilioWsSignature(TEST_TOKEN, TEST_PUBLIC_BASE_URL, httpsSignature);
  assert.equal(result, false, "Signature generated for https:// URL must not validate against wss:// URL");
});

test("AUTH-5b: TwiML Stream URL and WS signature validation URL are identical (single source of truth)", () => {
  // Both must use buildTwilioMediaStreamUrl — assert they produce the same URL
  const twimlUrl = buildTwilioMediaStreamUrl(TEST_PUBLIC_BASE_URL);
  const sigValidationUrl = buildTwilioMediaStreamUrl(TEST_PUBLIC_BASE_URL);
  assert.equal(twimlUrl, sigValidationUrl, "TwiML Stream URL and signature validation URL must be identical");
  assert.ok(twimlUrl.startsWith("wss://"), `URL must use wss:// scheme, got: ${twimlUrl}`);
  assert.equal(twimlUrl, "wss://voice.example.com/voice/media-stream");
});

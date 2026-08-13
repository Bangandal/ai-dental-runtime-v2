import assert from "node:assert/strict";
import test from "node:test";

import {
  transcribeAudio,
  MAX_AUDIO_BYTES,
  DEFAULT_TRANSCRIPTION_MODEL,
  type InboundAudio,
} from "../src/runtime/audioTranscription.ts";

const SMALL_OGG = Buffer.from("fake-audio-bytes");

function makeAudio(overrides: Partial<InboundAudio> = {}): InboundAudio {
  return {
    channel: "telegram",
    message_id: "msg_1",
    external_user_id: "user_1",
    mime_type: "audio/ogg",
    bytes: SMALL_OGG,
    ...overrides,
  };
}

function makeFetchOk(text: string): typeof globalThis.fetch {
  return async (_url, _opts) => {
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeFetchError(status: number): typeof globalThis.fetch {
  return async (_url, _opts) => {
    return new Response(JSON.stringify({ error: "bad" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// AUDIO-1: successful audio bytes → transcript text
test("AUDIO-1: successful transcription returns ok and text", async () => {
  const result = await transcribeAudio(
    makeAudio(),
    "sk-test",
    DEFAULT_TRANSCRIPTION_MODEL,
    makeFetchOk("транскрипция"),
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "транскрипция");
  assert.equal(result.model, DEFAULT_TRANSCRIPTION_MODEL);
});

// AUDIO-2: empty transcript → error_code empty_transcript
test("AUDIO-2: empty transcript returns empty_transcript error", async () => {
  const result = await transcribeAudio(
    makeAudio(),
    "sk-test",
    DEFAULT_TRANSCRIPTION_MODEL,
    makeFetchOk("   "),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "empty_transcript");
});

// AUDIO-3: transcription HTTP error → error_code transcription_http_error
test("AUDIO-3: transcription HTTP 500 returns transcription_http_error", async () => {
  const result = await transcribeAudio(
    makeAudio(),
    "sk-test",
    DEFAULT_TRANSCRIPTION_MODEL,
    makeFetchError(500),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "transcription_http_error");
});

// AUDIO-4: oversized audio → audio_too_large before any HTTP call
test("AUDIO-4: oversized audio returns audio_too_large without calling API", async () => {
  let fetchCalled = false;
  const trackingFetch: typeof globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };

  const result = await transcribeAudio(
    makeAudio({ bytes: Buffer.alloc(MAX_AUDIO_BYTES + 1) }),
    "sk-test",
    DEFAULT_TRANSCRIPTION_MODEL,
    trackingFetch,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "audio_too_large");
  assert.equal(fetchCalled, false, "fetch must not be called for oversized audio");
});

// AUDIO-5: unsupported mime type → unsupported_mime_type
test("AUDIO-5: unsupported mime type returns unsupported_mime_type", async () => {
  let fetchCalled = false;
  const trackingFetch: typeof globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };

  const result = await transcribeAudio(
    makeAudio({ mime_type: "video/mp4" }),
    "sk-test",
    DEFAULT_TRANSCRIPTION_MODEL,
    trackingFetch,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "unsupported_mime_type");
  assert.equal(fetchCalled, false);
});

// AUDIO-6: codec suffix in mime type is handled (e.g. audio/ogg; codecs=opus)
test("AUDIO-6: mime type with codec suffix is accepted", async () => {
  const result = await transcribeAudio(
    makeAudio({ mime_type: "audio/ogg; codecs=opus" }),
    "sk-test",
    DEFAULT_TRANSCRIPTION_MODEL,
    makeFetchOk("голосовое"),
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "голосовое");
});

// AUDIO-7: fetch throws → transcription_http_error
test("AUDIO-7: fetch throws non-timeout error returns transcription_http_error", async () => {
  const throwingFetch: typeof globalThis.fetch = async () => {
    throw new Error("network error");
  };

  const result = await transcribeAudio(
    makeAudio(),
    "sk-test",
    DEFAULT_TRANSCRIPTION_MODEL,
    throwingFetch,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "transcription_http_error");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createClinicCardAdapter,
  DEFAULT_CLINICCARD_TIMEOUT_MS,
  type ClinicCardFetch,
} from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import { DEFAULT_TELEGRAM_SEND_TIMEOUT_MS, sendTelegramMessage } from "../src/runtime/telegramSender.ts";
import { buildOpenAIClientOptions, OPENAI_CLIENT_MAX_RETRIES, OPENAI_CLIENT_TIMEOUT_MS } from "../src/main.ts";
import { bindOpenAIPerCallTimeout, OPENAI_CALL_TOTAL_TIMEOUT_MS } from "../src/runtime/openaiClientTimeout.ts";

const TEST_CONFIG: ClinicCardConfig = {
  api_base_url: "https://test.cliniccard.app",
  api_token: "test-placeholder-token",
  default_doctor_id: "10",
  default_cabinet_id: "2",
  timezone: "Europe/Prague",
  booking_mode: "disabled",
};

// A fetch that never responds on its own and rejects with the signal's reason
// (a TimeoutError DOMException for AbortSignal.timeout) once the signal fires —
// the same observable behavior as undici fetch on a timed-out request.
function hangingFetch(): { fetch: ClinicCardFetch; seenSignals: Array<AbortSignal | undefined> } {
  const seenSignals: Array<AbortSignal | undefined> = [];
  const fetch: ClinicCardFetch = (_url, init) => {
    seenSignals.push(init.signal);
    return new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return; // hangs forever — test would time out if signal is not wired
      // AbortSignal.timeout's internal timer is unref'ed and does not keep the
      // Node event loop alive; a real fetch's socket does. Hold a ref'ed timer
      // until the signal fires so the test process stays alive to observe it.
      const keepAlive = setTimeout(() => {}, 60_000);
      const onAbort = () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  return { fetch, seenSignals };
}

// ── ClinicCard adapter timeout ───────────────────────────────────────────────

test("ClinicCard: hanging request times out into a failed result, not an unhandled rejection", async () => {
  const { fetch, seenSignals } = hangingFetch();
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch, { timeoutMs: 20 });

  const result = await adapter.listVisits("2026-07-03", "2026-07-03");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_timeout");
    assert.match(result.error.message, /timed out after 20ms/);
  }
  assert.equal(seenSignals.length, 1);
  assert.ok(seenSignals[0] instanceof AbortSignal, "adapter must pass an AbortSignal to fetch");
});

test("ClinicCard: timeout error message does not contain the API token", async () => {
  const { fetch } = hangingFetch();
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch, { timeoutMs: 20 });

  const result = await adapter.findPatientByPhone("+420600111222");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(!result.error.message.includes(TEST_CONFIG.api_token), "token must not leak into timeout error");
    assert.ok(!JSON.stringify(result.error).includes(TEST_CONFIG.api_token));
  }
});

test("ClinicCard: createVisit timeout also returns structured failure (write path covered)", async () => {
  const { fetch } = hangingFetch();
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch, { timeoutMs: 20 });

  const result = await adapter.createVisit({
    patient_id: 1,
    doctor_id: 10,
    cabinet_id: 2,
    date: "2026-07-03",
    time_start: "10:00",
    time_end: "10:30",
    status: "PLANNED",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_timeout");
  }
});

test("ClinicCard: non-abort fetch failures keep the existing cliniccard_request_failed code", async () => {
  const failingFetch: ClinicCardFetch = async () => {
    throw new Error("socket hang up");
  };
  const adapter = createClinicCardAdapter(TEST_CONFIG, failingFetch, { timeoutMs: 20 });

  const result = await adapter.listVisits("2026-07-03", "2026-07-03");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_request_failed");
  }
});

test("ClinicCard: default timeout is 10 seconds", () => {
  assert.equal(DEFAULT_CLINICCARD_TIMEOUT_MS, 10_000);
});

// ── Telegram sender timeout ──────────────────────────────────────────────────

test("Telegram: hanging sendMessage times out into { ok: false } with a timeout error code", async () => {
  const seenSignals: Array<AbortSignal | undefined> = [];
  const fetchFn = ((_url: string, init?: RequestInit) => {
    seenSignals.push(init?.signal ?? undefined);
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      // Same keep-alive rationale as hangingFetch above.
      const keepAlive = setTimeout(() => {}, 60_000);
      const onAbort = () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }) as unknown as typeof globalThis.fetch;

  const result = await sendTelegramMessage({
    botToken: "test-bot-token",
    chatId: "12345",
    text: "hello",
    fetch: fetchFn,
    timeoutMs: 20,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "telegram_timeout:20ms");
  assert.equal(seenSignals.length, 1);
  assert.ok(seenSignals[0] instanceof AbortSignal, "sender must pass an AbortSignal to fetch");
});

test("Telegram: successful send is unaffected by the timeout wiring", async () => {
  const fetchFn = (async () => ({ ok: true, text: async () => "" })) as unknown as typeof globalThis.fetch;

  const result = await sendTelegramMessage({
    botToken: "test-bot-token",
    chatId: "12345",
    text: "hello",
    fetch: fetchFn,
    timeoutMs: 20,
  });

  assert.deepEqual(result, { ok: true });
});

test("Telegram: non-abort send failures still return { ok: false } without throwing", async () => {
  const fetchFn = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
  }) as unknown as typeof globalThis.fetch;

  const result = await sendTelegramMessage({
    botToken: "test-bot-token",
    chatId: "12345",
    text: "hello",
    fetch: fetchFn,
    timeoutMs: 20,
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ENOTFOUND/);
});

test("Telegram: default send timeout is 10 seconds", () => {
  assert.equal(DEFAULT_TELEGRAM_SEND_TIMEOUT_MS, 10_000);
});

// ── OpenAI client options ────────────────────────────────────────────────────

test("OpenAI: client options set explicit 60s timeout and 2 retries", () => {
  assert.equal(OPENAI_CLIENT_TIMEOUT_MS, 60_000);
  assert.equal(OPENAI_CLIENT_MAX_RETRIES, 2);
  assert.deepEqual(buildOpenAIClientOptions("sk-test"), {
    apiKey: "sk-test",
    timeout: 60_000,
    maxRetries: 2,
  });
});

// ── OpenAI per-call abort signal (Codex P2: bound body parse, not just headers) ──

interface RecordedCall {
  body: unknown;
  options: { signal?: AbortSignal } & Record<string, unknown>;
}

function fakeOpenAIClient(): {
  client: { responses: { create: (...args: unknown[]) => unknown }; conversations: { create: (...args: unknown[]) => unknown }; embeddings: { create: (...args: unknown[]) => unknown } };
  calls: Record<string, RecordedCall[]>;
} {
  const calls: Record<string, RecordedCall[]> = { responses: [], conversations: [], embeddings: [] };
  const makeResource = (name: string) => ({
    create: (body?: unknown, options?: RecordedCall["options"]) => {
      calls[name]!.push({ body, options: options ?? {} });
      return Promise.resolve({ ok: true });
    },
  });
  return {
    client: {
      responses: makeResource("responses"),
      conversations: makeResource("conversations"),
      embeddings: makeResource("embeddings"),
    },
    calls,
  };
}

test("OpenAI wrapper: injects an AbortSignal into responses/conversations/embeddings create calls", async () => {
  const { client, calls } = fakeOpenAIClient();
  bindOpenAIPerCallTimeout(client, 50);

  await client.responses.create({ model: "m", input: [] });
  await client.conversations.create();
  await client.embeddings.create({ model: "e", input: "text" });

  for (const name of ["responses", "conversations", "embeddings"] as const) {
    assert.equal(calls[name]!.length, 1, `${name}.create must be called once`);
    assert.ok(calls[name]![0]!.options.signal instanceof AbortSignal, `${name}.create must receive an AbortSignal`);
  }
  assert.deepEqual(calls.responses![0]!.body, { model: "m", input: [] });
});

test("OpenAI wrapper: never overrides a caller-provided signal", async () => {
  const { client, calls } = fakeOpenAIClient();
  bindOpenAIPerCallTimeout(client, 50);
  const explicit = new AbortController().signal;

  await client.responses.create({ model: "m" }, { signal: explicit });

  assert.equal(calls.responses![0]!.options.signal, explicit);
});

test("OpenAI wrapper: a call that stalls after headers is aborted by the injected signal", async () => {
  // Simulates the Codex P2 scenario: the SDK-level promise (headers + body parse)
  // never settles on its own and only rejects when the request signal fires —
  // exactly how fetch behaves for a stalled body read.
  const client = {
    responses: {
      create: (_body?: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) return; // would hang the test if no signal is injected
          const keepAlive = setTimeout(() => {}, 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          }, { once: true });
        }),
    },
  };
  bindOpenAIPerCallTimeout(client, 20);

  await assert.rejects(
    client.responses.create({ model: "m" }) as Promise<unknown>,
    (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"),
  );
});

test("OpenAI wrapper: clients with a partial surface (missing resources) are left intact", async () => {
  const client = { responses: { create: async () => ({ ok: true }) } } as Record<string, unknown>;
  assert.doesNotThrow(() => bindOpenAIPerCallTimeout(client, 50));
  const responses = client.responses as { create: () => Promise<unknown> };
  assert.deepEqual(await responses.create(), { ok: true });
});

test("OpenAI wrapper: default total per-call timeout is 90 seconds", () => {
  assert.equal(OPENAI_CALL_TOTAL_TIMEOUT_MS, 90_000);
});

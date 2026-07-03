import assert from "node:assert/strict";
import test from "node:test";

import { sendTelegramMessageWithRetry } from "../src/runtime/telegramSender.ts";
import { registerTelegramWebhookRoute } from "../src/runtime/telegramWebhookRoute.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";

const BASE_OPTS = {
  botToken: "bot_tok",
  chatId: "12345",
  text: "Здравствуйте!",
  retryBackoffMs: 0,
};

type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;

function okFetch(): FakeFetch {
  return async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function failFetch(status = 400, body = "Bad Request"): FakeFetch {
  return async () => new Response(body, { status });
}

function timeoutFetch(): FakeFetch {
  return async (_url, init) => {
    const signal = init?.signal as AbortSignal | undefined;
    await new Promise<void>((_resolve, reject) => {
      if (signal) signal.addEventListener("abort", () => reject(signal.reason));
    });
    return new Response("", { status: 200 });
  };
}

// ── sendTelegramMessageWithRetry ──────────────────────────────────────────────

test("successful send returns ok=true, retry_count=0", async () => {
  const result = await sendTelegramMessageWithRetry({ ...BASE_OPTS, fetch: okFetch() });
  assert.equal(result.ok, true);
  assert.equal(result.retry_count, 0);
  assert.equal(result.error_code, undefined);
});

test("first fail then retry succeeds returns ok=true, retry_count=1", async () => {
  let calls = 0;
  const fetchFn: FakeFetch = async () => {
    calls++;
    if (calls === 1) return new Response("error", { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const result = await sendTelegramMessageWithRetry({ ...BASE_OPTS, fetch: fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.retry_count, 1);
  assert.equal(calls, 2);
});

test("permanent fail returns ok=false, retry_count=1, error_code=telegram_send_failed", async () => {
  let calls = 0;
  const fetchFn: FakeFetch = async () => {
    calls++;
    return new Response("server error", { status: 500 });
  };
  const result = await sendTelegramMessageWithRetry({ ...BASE_OPTS, fetch: fetchFn });
  assert.equal(result.ok, false);
  assert.equal(result.retry_count, 1);
  assert.equal(result.error_code, "telegram_send_failed");
  assert.ok(typeof result.error === "string" && result.error.length > 0);
  assert.equal(calls, 2);
});

test("permanent fail does not throw", async () => {
  const fetchFn: FakeFetch = async () => new Response("error", { status: 500 });
  await assert.doesNotReject(sendTelegramMessageWithRetry({ ...BASE_OPTS, fetch: fetchFn }));
});

test("timeout returns ok=false, retry_count=0, error_code=telegram_timeout without retrying", async () => {
  let calls = 0;
  const fetchFn: FakeFetch = async (_url, init) => {
    calls++;
    const signal = init?.signal as AbortSignal | undefined;
    // Use a ref'd backup timer so the event loop stays alive while waiting for the AbortSignal.
    // AbortSignal.timeout() uses an unref'd timer which would let the loop go idle prematurely.
    return new Promise<Response>((_, reject) => {
      const backup = setTimeout(() => reject(new Error("backup-timeout")), 5000);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(backup);
          reject(signal.reason);
        });
      }
    });
  };
  const result = await sendTelegramMessageWithRetry({ ...BASE_OPTS, fetch: fetchFn, timeoutMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.retry_count, 0);
  assert.equal(result.error_code, "telegram_timeout");
  assert.equal(calls, 1, "timeout must not trigger retry");
});

// ── Telegram webhook route delivery observability ────────────────────────────

const CLINIC_CODE = "clinic_1";
const CLINIC_UUID = "e8179559-fc8d-40e5-9808-287ed69fcf7c";

const clinicResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC_CODE) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC_CODE } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
  },
};

function stubService(reply = "Чем могу помочь?"): RuntimeTurnService {
  return {
    async runTurn() {
      return { final_patient_reply: reply, conversation_id: null, tool_requests: [], tool_results: [] };
    },
  };
}

const TEXT_UPDATE = {
  update_id: 8001,
  message: {
    message_id: 401,
    chat: { id: 777, type: "private" },
    from: { id: 888, first_name: "Test" },
    text: "Привет",
  },
};

async function invokeWebhook(
  deps: Parameters<typeof registerTelegramWebhookRoute>[1],
  update = TEXT_UPDATE,
): Promise<{ code: number }> {
  let handler: ((req: unknown, rep: unknown) => Promise<void>) | undefined;
  registerTelegramWebhookRoute({ post(_p, h) { handler = h; } }, deps);
  let sentCode = 200;
  const reply = {
    code(n: number) { sentCode = n; return reply; },
    send(_: unknown) {},
  };
  await (handler as Function)({ body: update, headers: {}, ip: "127.0.0.1" }, reply);
  return { code: sentCode };
}

test("webhook records delivery ok=true on successful send via onTelegramDelivery", async () => {
  const deliveries: unknown[] = [];
  await invokeWebhook({
    runtimeTurnService: stubService(),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    fetch: okFetch(),
    telegramRetryBackoffMs: 0,
    onTelegramDelivery: (o) => deliveries.push(o),
  });
  assert.equal(deliveries.length, 1);
  const d = deliveries[0] as Record<string, unknown>;
  assert.equal(d.ok, true);
  assert.equal(d.retry_count, 0);
  assert.equal(typeof d.trace_id, "string");
});

test("webhook records retry_count=1 when first send fails then retry succeeds", async () => {
  let calls = 0;
  const fetchFn: FakeFetch = async () => {
    calls++;
    if (calls === 1) return new Response("error", { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const deliveries: unknown[] = [];
  await invokeWebhook({
    runtimeTurnService: stubService(),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    fetch: fetchFn,
    telegramRetryBackoffMs: 0,
    onTelegramDelivery: (o) => deliveries.push(o),
  });
  const d = deliveries[0] as Record<string, unknown>;
  assert.equal(d.ok, true);
  assert.equal(d.retry_count, 1);
});

test("webhook records ok=false on permanent failure and does not throw", async () => {
  const deliveries: unknown[] = [];
  await assert.doesNotReject(invokeWebhook({
    runtimeTurnService: stubService(),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    fetch: failFetch(500),
    telegramRetryBackoffMs: 0,
    onTelegramDelivery: (o) => deliveries.push(o),
  }));
  const d = deliveries[0] as Record<string, unknown>;
  assert.equal(d.ok, false);
  assert.equal(d.retry_count, 1);
  assert.ok(typeof d.error_code === "string");
});

test("webhook returns 200 even when Telegram send permanently fails", async () => {
  const { code } = await invokeWebhook({
    runtimeTurnService: stubService(),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    fetch: failFetch(500),
    telegramRetryBackoffMs: 0,
  });
  assert.equal(code, 200);
});

test("webhook does not change patient-facing reply text", async () => {
  const expectedReply = "Вы записаны на чистку зубов 7 июля в 10:00.";
  const sentBodies: Record<string, unknown>[] = [];
  const fetchFn: FakeFetch = async (_url, init) => {
    sentBodies.push(JSON.parse((init?.body as string) ?? "{}"));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await invokeWebhook({
    runtimeTurnService: stubService(expectedReply),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    fetch: fetchFn,
    telegramRetryBackoffMs: 0,
  });
  const sendMsg = sentBodies.find((b) => "text" in b);
  assert.equal(sendMsg?.text, expectedReply);
});

test("onTelegramDelivery throws -> webhook still returns 200", async () => {
  const { code } = await invokeWebhook({
    runtimeTurnService: stubService(),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    fetch: okFetch(),
    telegramRetryBackoffMs: 0,
    onTelegramDelivery: () => { throw new Error("observer kaboom"); },
  });
  assert.equal(code, 200);
});

test("send ok + callback throws -> no throw from webhook", async () => {
  await assert.doesNotReject(invokeWebhook({
    runtimeTurnService: stubService(),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    fetch: okFetch(),
    telegramRetryBackoffMs: 0,
    onTelegramDelivery: () => { throw new Error("observer kaboom"); },
  }));
});

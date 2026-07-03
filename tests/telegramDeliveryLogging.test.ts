import assert from "node:assert/strict";
import test from "node:test";
import { registerTelegramWebhookRoute } from "../src/runtime/telegramWebhookRoute.ts";
import { createDeliveryObserver } from "../src/runtime/runtimeServerBootstrap.ts";
import type { RuntimeTurnLogger, TelegramDeliveryLogEvent } from "../src/runtime/runtimeTurnLogger.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { TelegramDeliveryOutcome } from "../src/runtime/telegramSender.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function spyLogger() {
  const events: TelegramDeliveryLogEvent[] = [];
  const logger: RuntimeTurnLogger = {
    async logTurn() {},
    async logError() {},
    async logDelivery(event) { events.push(event); },
  };
  return { logger, events };
}

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
  update_id: 9001,
  message: {
    message_id: 501,
    chat: { id: 999, type: "private" },
    from: { id: 111, first_name: "Test" },
    text: "Привет",
  },
};

type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;

function okFetch(): FakeFetch {
  return async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function failFetch(status = 500): FakeFetch {
  return async () => new Response("server error", { status });
}


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

function baseDeps(overrides: Partial<Parameters<typeof registerTelegramWebhookRoute>[1]> = {}): Parameters<typeof registerTelegramWebhookRoute>[1] {
  return {
    runtimeTurnService: stubService(),
    clinicIdentityResolver: clinicResolver,
    botToken: "tok",
    webhookSecret: undefined,
    defaultClinicCode: CLINIC_CODE,
    isProduction: false,
    telegramRetryBackoffMs: 0,
    ...overrides,
  };
}

// ── createDeliveryObserver / bootstrap wiring ────────────────────────────────

test("bootstrap wires onTelegramDelivery: observer calls logDelivery with correct fields", async () => {
  const { logger, events } = spyLogger();
  const observer = createDeliveryObserver(logger);

  const outcome: TelegramDeliveryOutcome & { trace_id: string } = {
    ok: true,
    retry_count: 0,
    trace_id: "trace-001",
  };
  observer(outcome);

  // logDelivery is async; give the microtask queue a tick
  await new Promise<void>((r) => setTimeout(r, 10));

  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.ok, true);
  assert.equal(e.retry_count, 0);
  assert.equal(e.trace_id, "trace-001");
  assert.equal(typeof e.ts, "string");
  assert.equal(e.error_code, undefined);
  assert.equal(e.error, undefined);
});

test("observer truncates error to 300 chars", async () => {
  const { logger, events } = spyLogger();
  const observer = createDeliveryObserver(logger);

  const longError = "x".repeat(500);
  observer({ ok: false, retry_count: 1, error_code: "telegram_send_failed", error: longError, trace_id: "t1" });
  await new Promise<void>((r) => setTimeout(r, 10));

  assert.equal(events[0].error?.length, 300);
});

test("observer swallows logDelivery rejection — never throws", async () => {
  const throwingLogger: RuntimeTurnLogger = {
    async logTurn() {},
    async logError() {},
    async logDelivery() { throw new Error("log write failed"); },
  };
  const observer = createDeliveryObserver(throwingLogger);

  await assert.doesNotReject(
    new Promise<void>((resolve) => {
      observer({ ok: true, retry_count: 0, trace_id: "t2" });
      setTimeout(resolve, 20);
    }),
  );
});

// ── end-to-end: webhook -> onTelegramDelivery -> logDelivery ─────────────────

test("successful send produces telegram_delivery ok=true in log event", async () => {
  const { logger, events } = spyLogger();
  await invokeWebhook(baseDeps({
    fetch: okFetch(),
    onTelegramDelivery: createDeliveryObserver(logger),
  }));
  await new Promise<void>((r) => setTimeout(r, 20));

  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].retry_count, 0);
  assert.equal(typeof events[0].trace_id, "string");
});

test("retry success logs retry_count=1", async () => {
  let calls = 0;
  const fetchFn: FakeFetch = async () => {
    calls++;
    if (calls === 1) return new Response("error", { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const { logger, events } = spyLogger();
  await invokeWebhook(baseDeps({
    fetch: fetchFn,
    onTelegramDelivery: createDeliveryObserver(logger),
  }));
  await new Promise<void>((r) => setTimeout(r, 20));

  assert.equal(events[0].ok, true);
  assert.equal(events[0].retry_count, 1);
});

test("permanent failure logs ok=false and error_code=telegram_send_failed", async () => {
  const { logger, events } = spyLogger();
  await invokeWebhook(baseDeps({
    fetch: failFetch(500),
    onTelegramDelivery: createDeliveryObserver(logger),
  }));
  await new Promise<void>((r) => setTimeout(r, 20));

  assert.equal(events[0].ok, false);
  assert.equal(events[0].error_code, "telegram_send_failed");
  assert.equal(events[0].retry_count, 1);
});

// Timeout behavior of sendTelegramMessageWithRetry is covered in telegramSenderDelivery.test.ts.
// Here we verify the observer correctly logs the timeout outcome it receives.
test("timeout outcome logs error_code=telegram_timeout via observer", async () => {
  const { logger, events } = spyLogger();
  const observer = createDeliveryObserver(logger);

  // Simulate the outcome that sendTelegramMessageWithRetry produces on timeout
  observer({ ok: false, retry_count: 0, error_code: "telegram_timeout", error: "telegram_timeout:10000ms", trace_id: "trace-timeout" });
  await new Promise<void>((r) => setTimeout(r, 10));

  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
  assert.equal(events[0].error_code, "telegram_timeout");
  assert.equal(events[0].retry_count, 0);
  assert.equal(events[0].trace_id, "trace-timeout");
});

test("logDelivery failure does not break webhook — still returns 200", async () => {
  const throwingLogger: RuntimeTurnLogger = {
    async logTurn() {},
    async logError() {},
    async logDelivery() { throw new Error("disk full"); },
  };
  const { code } = await invokeWebhook(baseDeps({
    fetch: okFetch(),
    onTelegramDelivery: createDeliveryObserver(throwingLogger),
  }));
  assert.equal(code, 200);
});

test("patient-facing reply text unchanged when delivery observer is wired", async () => {
  const expectedReply = "Запись подтверждена на пятницу в 10:00.";
  const sentBodies: Record<string, unknown>[] = [];
  const fetchFn: FakeFetch = async (_url, init) => {
    sentBodies.push(JSON.parse((init?.body as string) ?? "{}"));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const { logger } = spyLogger();
  await invokeWebhook(baseDeps({
    runtimeTurnService: stubService(expectedReply),
    fetch: fetchFn,
    onTelegramDelivery: createDeliveryObserver(logger),
  }));
  const sendMsg = sentBodies.find((b) => "text" in b);
  assert.equal(sendMsg?.text, expectedReply);
});

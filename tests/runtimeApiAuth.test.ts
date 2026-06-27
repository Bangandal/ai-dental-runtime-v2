import assert from "node:assert/strict";
import test from "node:test";

import { checkRuntimeApiKey, extractBearerToken } from "../src/runtime/runtimeApiAuth.ts";
import { createRateLimiter, createNoopRateLimiter } from "../src/runtime/runtimeRateLimiter.ts";
import { registerRuntimeTurnRoute } from "../src/runtime/runtimeTurnHttpRoute.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import { createNoopRuntimeTurnLogger } from "../src/runtime/runtimeTurnLogger.ts";

// ── extractBearerToken ───────────────────────────────────────────────────────

test("extractBearerToken: extracts token from valid Bearer header", () => {
  assert.equal(extractBearerToken("Bearer abc123"), "abc123");
  assert.equal(extractBearerToken("bearer abc123"), "abc123");
  assert.equal(extractBearerToken("BEARER abc123"), "abc123");
});

test("extractBearerToken: returns null for non-Bearer header", () => {
  assert.equal(extractBearerToken("Basic abc123"), null);
  assert.equal(extractBearerToken("abc123"), null);
  assert.equal(extractBearerToken(""), null);
  assert.equal(extractBearerToken(undefined), null);
});

// ── checkRuntimeApiKey ───────────────────────────────────────────────────────

test("checkRuntimeApiKey: no configured key in production → fail closed (unconfigured)", () => {
  const result = checkRuntimeApiKey({
    configuredKey: undefined,
    authHeader: "Bearer anykey",
    apiKeyHeader: undefined,
    isProduction: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unconfigured");
});

test("checkRuntimeApiKey: no configured key outside production → allow (dev convenience)", () => {
  const result = checkRuntimeApiKey({
    configuredKey: undefined,
    authHeader: undefined,
    apiKeyHeader: undefined,
    isProduction: false,
  });
  assert.equal(result.ok, true);
});

test("checkRuntimeApiKey: valid Authorization Bearer key → allowed", () => {
  const result = checkRuntimeApiKey({
    configuredKey: "secret-key",
    authHeader: "Bearer secret-key",
    apiKeyHeader: undefined,
    isProduction: true,
  });
  assert.equal(result.ok, true);
});

test("checkRuntimeApiKey: valid X-Runtime-API-Key header → allowed", () => {
  const result = checkRuntimeApiKey({
    configuredKey: "secret-key",
    authHeader: undefined,
    apiKeyHeader: "secret-key",
    isProduction: true,
  });
  assert.equal(result.ok, true);
});

test("checkRuntimeApiKey: wrong key → unauthorized", () => {
  const result = checkRuntimeApiKey({
    configuredKey: "secret-key",
    authHeader: "Bearer wrong-key",
    apiKeyHeader: undefined,
    isProduction: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unauthorized");
});

test("checkRuntimeApiKey: no request key provided → unauthorized", () => {
  const result = checkRuntimeApiKey({
    configuredKey: "secret-key",
    authHeader: undefined,
    apiKeyHeader: undefined,
    isProduction: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unauthorized");
});

test("checkRuntimeApiKey: empty string key headers → unauthorized", () => {
  const result = checkRuntimeApiKey({
    configuredKey: "secret-key",
    authHeader: "Bearer ",
    apiKeyHeader: "",
    isProduction: true,
  });
  assert.equal(result.ok, false);
});

// ── createRateLimiter ────────────────────────────────────────────────────────

test("rate limiter: allows requests up to the limit", () => {
  const limiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000 });
  assert.equal(limiter.check("key1"), true);
  assert.equal(limiter.check("key1"), true);
  assert.equal(limiter.check("key1"), true);
});

test("rate limiter: blocks requests over the limit", () => {
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  limiter.check("key2");
  limiter.check("key2");
  assert.equal(limiter.check("key2"), false);
});

test("rate limiter: different keys have independent counts", () => {
  const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  assert.equal(limiter.check("keyA"), true);
  assert.equal(limiter.check("keyA"), false);
  assert.equal(limiter.check("keyB"), true); // separate key — allowed
});

test("rate limiter: window resets after windowMs", async () => {
  const limiter = createRateLimiter({ maxRequests: 1, windowMs: 50 });
  assert.equal(limiter.check("key3"), true);
  assert.equal(limiter.check("key3"), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(limiter.check("key3"), true); // window expired — allowed again
});

test("noop rate limiter: always allows", () => {
  const limiter = createNoopRateLimiter();
  for (let i = 0; i < 200; i++) assert.equal(limiter.check("any"), true);
});

// ── route integration: auth ──────────────────────────────────────────────────

const CLINIC_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const defaultClinicResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === "clinic_1") {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: "clinic_1" } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
  },
};
const stubService: RuntimeTurnService = {
  async runTurn() {
    return { final_patient_reply: "Hi", tool_results: [], debug: { llm_calls: { main_agent_called: true, total_llm_calls: 1, runtime_gate_called: false, turn_understanding_called: false, legacy_case_router_called: false } } };
  },
};

function makeRouteHarness(opts: {
  apiKey?: string;
  isProduction?: boolean;
  rateLimiter?: import("../src/runtime/runtimeRateLimiter.ts").RateLimiter;
  debugEnabled?: boolean;
}) {
  let handler: ((request: any, reply: any) => Promise<void>) | undefined;
  registerRuntimeTurnRoute(
    { post(_, h) { handler = h; } },
    {
      runtimeTurnService: stubService,
      runtimeTurnLogger: createNoopRuntimeTurnLogger(),
      clinicIdentityResolver: defaultClinicResolver,
      ...opts,
    },
  );
  assert.ok(handler);

  async function invoke(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    let statusCode = 200;
    let payload: unknown;
    const reply = {
      code(c: number) { statusCode = c; return reply; },
      send(p: unknown) { payload = p; },
    };
    await handler!({ body, headers, ip: "127.0.0.1" }, reply);
    await new Promise((r) => setTimeout(r, 20));
    return { statusCode, payload };
  }

  return { invoke };
}

const VALID_BODY = { clinic_code: "clinic_1", channel: "web", external_user_id: "u1", text: "hello" };

test("route: request without API key returns 401 when key is configured", async () => {
  const { invoke } = makeRouteHarness({ apiKey: "secret", isProduction: true });
  const { statusCode, payload } = await invoke(VALID_BODY, {});
  assert.equal(statusCode, 401);
  assert.equal((payload as any).error.code, "unauthorized");
});

test("route: request with wrong API key returns 401", async () => {
  const { invoke } = makeRouteHarness({ apiKey: "secret", isProduction: true });
  const { statusCode } = await invoke(VALID_BODY, { authorization: "Bearer wrong" });
  assert.equal(statusCode, 401);
});

test("route: valid Authorization Bearer key allows request", async () => {
  const { invoke } = makeRouteHarness({ apiKey: "secret", isProduction: false });
  const { statusCode } = await invoke(VALID_BODY, { authorization: "Bearer secret" });
  assert.equal(statusCode, 200);
});

test("route: valid X-Runtime-API-Key header allows request", async () => {
  const { invoke } = makeRouteHarness({ apiKey: "secret", isProduction: false });
  const { statusCode } = await invoke(VALID_BODY, { "x-runtime-api-key": "secret" });
  assert.equal(statusCode, 200);
});

test("route: missing RUNTIME_API_KEY in production fails closed (401)", async () => {
  const { invoke } = makeRouteHarness({ apiKey: undefined, isProduction: true });
  const { statusCode, payload } = await invoke(VALID_BODY, { authorization: "Bearer anything" });
  assert.equal(statusCode, 401);
  assert.equal((payload as any).error.code, "unauthorized");
});

// ── route integration: rate limiting ─────────────────────────────────────────

test("route: rate limit returns 429 after threshold exceeded", async () => {
  const rateLimiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  const { invoke } = makeRouteHarness({ apiKey: "k", rateLimiter });
  await invoke(VALID_BODY, { authorization: "Bearer k" }); // 1
  await invoke(VALID_BODY, { authorization: "Bearer k" }); // 2
  const { statusCode, payload } = await invoke(VALID_BODY, { authorization: "Bearer k" }); // 3 → 429
  assert.equal(statusCode, 429);
  assert.equal((payload as any).error.code, "rate_limit_exceeded");
});

// ── route integration: debug response control ─────────────────────────────────

test("route: debug field absent from response by default (debugEnabled not set)", async () => {
  const { invoke } = makeRouteHarness({});
  const { statusCode, payload } = await invoke(VALID_BODY, {});
  assert.equal(statusCode, 200);
  assert.equal("debug" in (payload as any), false, "debug must be absent when debugEnabled is not set");
});

test("route: debug field present when debugEnabled=true", async () => {
  const { invoke } = makeRouteHarness({ debugEnabled: true });
  const { statusCode, payload } = await invoke(VALID_BODY, {});
  assert.equal(statusCode, 200);
  assert.equal("debug" in (payload as any), true, "debug must be present when debugEnabled=true");
});

test("route: API key value does not appear in response body", async () => {
  const { invoke } = makeRouteHarness({ apiKey: "super-secret-key-12345", debugEnabled: true });
  const { payload } = await invoke(VALID_BODY, { authorization: "Bearer super-secret-key-12345" });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("super-secret-key-12345"), "API key must not appear in response");
});

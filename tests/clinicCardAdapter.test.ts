import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { createClinicCardAdapter, type ClinicCardFetch } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig, ClinicCardCreateVisitInput } from "../src/integrations/cliniccard/clinicCardTypes.ts";

const TEST_CONFIG: ClinicCardConfig = {
  api_base_url: "https://test.cliniccard.app",
  api_token: "test-placeholder-token",
  default_doctor_id: "10",
  default_cabinet_id: "2",
  timezone: "Europe/Prague",
  booking_mode: "disabled",
};

function mockFetch(
  responseData: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetch: ClinicCardFetch; calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetch: ClinicCardFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const ok = opts.ok ?? true;
    const status = opts.status ?? 200;
    return {
      ok,
      status,
      json: async () => responseData,
      text: async () => JSON.stringify(responseData),
    };
  };
  return { fetch, calls };
}

// ── Auth header ──────────────────────────────────────────────────────────────

test("Token auth header is built correctly — value matches config token", async () => {
  const { fetch, calls } = mockFetch([]);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  await adapter.findPatientByPhone("+420123456789");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers["Token"], TEST_CONFIG.api_token);
});

// ── findPatientByPhone ───────────────────────────────────────────────────────

test("findPatientByPhone sends GET to /api/patients with phone query param", async () => {
  const { fetch, calls } = mockFetch([{ id: 1, name: "Jan Novák", phone: "+420111222333" }]);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.findPatientByPhone("+420111222333");
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.method, "GET");
  assert.match(calls[0]!.url, /\/api\/patients/);
  assert.match(calls[0]!.url, /phone=%2B420111222333/);
});

// ── createPatient ────────────────────────────────────────────────────────────

test("createPatient sends POST to /api/patients with name in body", async () => {
  const { fetch, calls } = mockFetch({ id: 5, name: "Jana Procházková" });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createPatient({ name: "Jana Procházková", phone: "+420777888999" });
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/api\/patients/);
  assert.equal((calls[0]!.body as Record<string, unknown>)?.name, "Jana Procházková");
  assert.equal((calls[0]!.body as Record<string, unknown>)?.phone, "+420777888999");
});

// ── listVisits ───────────────────────────────────────────────────────────────

test("listVisits sends GET to /api/visits with from and to query params", async () => {
  const { fetch, calls } = mockFetch([]);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  await adapter.listVisits("2026-07-01", "2026-07-31");
  assert.equal(calls[0]!.method, "GET");
  assert.match(calls[0]!.url, /\/api\/visits/);
  assert.match(calls[0]!.url, /from=2026-07-01/);
  assert.match(calls[0]!.url, /to=2026-07-31/);
});

// ── createVisit ──────────────────────────────────────────────────────────────

test("createVisit sends POST to /api/visits with all required fields", async () => {
  const visitInput: ClinicCardCreateVisitInput = {
    patient_id: 1,
    doctor_id: 10,
    cabinet_id: 2,
    date: "2026-07-15",
    time_start: "09:00",
    time_end: "09:30",
    status: "PLANNED",
    note: "Hygiene appointment",
  };
  const { fetch, calls } = mockFetch({ id: 99, ...visitInput });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit(visitInput);
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/api\/visits/);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.patient_id, 1);
  assert.equal(body.doctor_id, 10);
  assert.equal(body.cabinet_id, 2);
  assert.equal(body.date, "2026-07-15");
  assert.equal(body.time_start, "09:00");
  assert.equal(body.time_end, "09:30");
});

// ── listPayments ─────────────────────────────────────────────────────────────

test("listPayments sends GET to /api/payments with from and to query params", async () => {
  const { fetch, calls } = mockFetch([]);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  await adapter.listPayments("2026-07-01", "2026-07-31");
  assert.equal(calls[0]!.method, "GET");
  assert.match(calls[0]!.url, /\/api\/payments/);
  assert.match(calls[0]!.url, /from=2026-07-01/);
  assert.match(calls[0]!.url, /to=2026-07-31/);
});

// ── Token redaction ──────────────────────────────────────────────────────────

test("token is redacted in HTTP error message", async () => {
  const realToken = TEST_CONFIG.api_token;
  const { fetch } = mockFetch(`Unauthorized: ${realToken}`, { ok: false, status: 401 });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.findPatientByPhone("+420111222333");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.error.message, new RegExp(realToken));
    assert.match(result.error.message, /\[REDACTED\]/);
  }
});

test("token is redacted when fetch throws with token in error message", async () => {
  const realToken = TEST_CONFIG.api_token;
  const throwingFetch: ClinicCardFetch = async () => {
    throw new Error(`Connection error with token=${realToken}`);
  };
  const adapter = createClinicCardAdapter(TEST_CONFIG, throwingFetch);
  const result = await adapter.findPatientByPhone("+420111222333");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.error.message, new RegExp(realToken));
    assert.match(result.error.message, /\[REDACTED\]/);
  }
});

// ── Runtime isolation ────────────────────────────────────────────────────────

test("clinicCardAdapter is not imported by runtimeAgentLoop", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const loopSrc = readFileSync(resolve(dir, "../src/runtime/runtimeAgentLoop.ts"), "utf8");
  assert.doesNotMatch(loopSrc, /cliniccard/i, "runtimeAgentLoop must not reference cliniccard adapter");
});

test("clinicCardAdapter is not imported by dentalRuntimeAgentFactory", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const factorySrc = readFileSync(resolve(dir, "../src/runtime/dentalRuntimeAgentFactory.ts"), "utf8");
  assert.doesNotMatch(factorySrc, /cliniccard/i, "dentalRuntimeAgentFactory must not reference cliniccard adapter");
});

test("clinicCardAdapter is not imported by runtimeTurnPipeline", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const pipelineSrc = readFileSync(resolve(dir, "../src/runtime/runtimeTurnPipeline.ts"), "utf8");
  assert.doesNotMatch(pipelineSrc, /cliniccard/i, "runtimeTurnPipeline must not reference cliniccard adapter");
});

// ── createPatient validation ─────────────────────────────────────────────────

test("createPatient with blank name returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createPatient({ name: "   " });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /name/);
  }
  assert.equal(calls.length, 0, "fetch must not be called when validation fails");
});

test("createPatient with missing name returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  // Cast to bypass TypeScript — simulates malformed runtime input
  const result = await adapter.createPatient({ name: "" } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
  }
  assert.equal(calls.length, 0);
});

// phone is explicitly optional for createPatient:
// ClinicCard allows registering a patient by name only (e.g. booking for a family member
// whose phone is unknown). Phone can be added after registration via patient update.
test("createPatient without phone succeeds and sends POST — phone is optional in ClinicCard", async () => {
  const { fetch, calls } = mockFetch({ id: 7, name: "Anna Nováková" });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createPatient({ name: "Anna Nováková" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.body as Record<string, unknown>)?.name, "Anna Nováková");
  assert.equal((calls[0]!.body as Record<string, unknown>)?.phone, undefined);
});

// ── createVisit validation ────────────────────────────────────────────────────

const VALID_VISIT: ClinicCardCreateVisitInput = {
  patient_id: 1,
  doctor_id: 10,
  cabinet_id: 2,
  date: "2026-07-15",
  time_start: "09:00",
  time_end: "09:30",
  status: "PLANNED",
};

test("createVisit missing patient_id returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ ...VALID_VISIT, patient_id: 0 } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /patient_id/);
  }
  assert.equal(calls.length, 0);
});

test("createVisit missing doctor_id returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ ...VALID_VISIT, doctor_id: 0 } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /doctor_id/);
  }
  assert.equal(calls.length, 0);
});

test("createVisit missing cabinet_id returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ ...VALID_VISIT, cabinet_id: 0 } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /cabinet_id/);
  }
  assert.equal(calls.length, 0);
});

test("createVisit missing date returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ ...VALID_VISIT, date: "" } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /date/);
  }
  assert.equal(calls.length, 0);
});

test("createVisit missing time_start returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ ...VALID_VISIT, time_start: "" } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /time_start/);
  }
  assert.equal(calls.length, 0);
});

test("createVisit missing time_end returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ ...VALID_VISIT, time_end: "" } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /time_end/);
  }
  assert.equal(calls.length, 0);
});

test("createVisit invalid status returns validation error and fetch is not called", async () => {
  const { fetch, calls } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ ...VALID_VISIT, status: "UNKNOWN_STATUS" } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_validation_error");
    assert.match(result.error.message, /status/);
  }
  assert.equal(calls.length, 0);
});

test("validation error message never contains the API token", async () => {
  const { fetch } = mockFetch({});
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createPatient({ name: "" } as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.error.message, new RegExp(TEST_CONFIG.api_token));
  }
});

// ── URL construction with production base URL ────────────────────────────────

test("listVisits builds full URL as https://cliniccards.com/api/visits?from=...&to=...", async () => {
  const { fetch, calls } = mockFetch([]);
  const prodConfig: ClinicCardConfig = { ...TEST_CONFIG, api_base_url: "https://cliniccards.com" };
  const adapter = createClinicCardAdapter(prodConfig, fetch);
  await adapter.listVisits("2026-07-01", "2026-07-31");
  assert.equal(calls[0]!.url, "https://cliniccards.com/api/visits?from=2026-07-01&to=2026-07-31");
});

// ── No live side effects ─────────────────────────────────────────────────────

test("adapter operations do not call Supabase, n8n, or Telegram — only ClinicCard base URL", async () => {
  const seenUrls: string[] = [];
  const trackingFetch: ClinicCardFetch = async (url, _init) => {
    seenUrls.push(url);
    return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
  };
  const adapter = createClinicCardAdapter(TEST_CONFIG, trackingFetch);
  await adapter.listVisits("2026-07-01", "2026-07-31");
  await adapter.listPayments("2026-07-01", "2026-07-31");
  for (const url of seenUrls) {
    assert.match(url, /^https:\/\/test\.cliniccard\.app/, `Unexpected URL: ${url}`);
  }
});

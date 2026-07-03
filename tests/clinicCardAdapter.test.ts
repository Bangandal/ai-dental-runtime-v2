import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { createClinicCardAdapter, unwrapClinicCardResponse, type ClinicCardFetch } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
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

test("createPatient sends {firstname, lastname, phone} — not {name} — to ClinicCard API", async () => {
  const { fetch, calls } = mockFetch({ patient_id: 5, firstname: "Jana", lastname: "Procházková", phone: "+420777888999" });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createPatient({ name: "Jana Procházková", phone: "+420777888999" });
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/api\/patients/);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.firstname, "Jana");
  assert.equal(body.lastname, "Procházková");
  assert.equal(body.phone, "+420777888999");
  assert.equal(body.name, undefined);
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
  assert.equal(body.visit_start, "2026-07-15 09:00:00");
  assert.equal(body.visit_end, "2026-07-15 09:30:00");
  assert.equal(body.time_start, undefined);
  assert.equal(body.time_end, undefined);
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

test("clinicCardAdapter HTTP client is not imported directly by dentalRuntimeAgentFactory", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const factorySrc = readFileSync(resolve(dir, "../src/runtime/dentalRuntimeAgentFactory.ts"), "utf8");
  // The factory wires the ClinicCard availability executor (ok) but must not import the raw HTTP adapter
  assert.doesNotMatch(factorySrc, /clinicCardAdapter/, "dentalRuntimeAgentFactory must not import the raw ClinicCard HTTP adapter");
  assert.doesNotMatch(factorySrc, /createClinicCardAdapter/, "dentalRuntimeAgentFactory must not call createClinicCardAdapter directly");
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
  const { fetch, calls } = mockFetch({ patient_id: "7", firstname: "Anna", lastname: "Nováková" });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createPatient({ name: "Anna Nováková" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.firstname, "Anna");
  assert.equal(body.lastname, "Nováková");
  assert.equal(body.name, undefined);
  assert.equal(body.phone, undefined);
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

// ── unwrapClinicCardResponse ──────────────────────────────────────────────────

test("unwrapClinicCardResponse returns data from {data, result:'ok', error:null} envelope", () => {
  const result = unwrapClinicCardResponse<string[]>({ data: ["a", "b"], result: "ok", error: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, ["a", "b"]);
});

test("unwrapClinicCardResponse returns data from {data, result:'success', error:null} envelope", () => {
  const result = unwrapClinicCardResponse<string[]>({ data: ["a", "b"], result: "success", error: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, ["a", "b"]);
});

test("unwrapClinicCardResponse returns error from envelope with result!='ok'", () => {
  const result = unwrapClinicCardResponse<string[]>({ data: null, result: "error", error: "Not found" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_api_error");
    assert.match(result.error.message, /Not found/);
  }
});

test("unwrapClinicCardResponse returns generic error when error field is empty", () => {
  const result = unwrapClinicCardResponse<string[]>({ data: null, result: "error", error: null });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "cliniccard_api_error");
});

test("unwrapClinicCardResponse treats plain array as raw (backward compat)", () => {
  const result = unwrapClinicCardResponse<string[]>(["x", "y"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, ["x", "y"]);
});

test("unwrapClinicCardResponse treats plain object without envelope shape as raw", () => {
  const result = unwrapClinicCardResponse<{ id: number }>({ id: 42 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, { id: 42 });
});

// ── Adapter reads with real ClinicCard envelope format ────────────────────────

const WRAPPED_PATIENT = { data: [{ id: 1, name: "Test Patient", phone: "+420111222333" }], result: "success", error: null };
const WRAPPED_VISITS = { data: [{ id: 10, patient_id: 1, doctor_id: 10, cabinet_id: 2, date: "2026-07-01", time_start: "09:00", time_end: "09:30", status: "PLANNED" }], result: "success", error: null };
const WRAPPED_EMPTY = { data: [], result: "success", error: null };

test("findPatientByPhone unwraps {data:[...], result:'ok', error:null} into array", async () => {
  const { fetch } = mockFetch(WRAPPED_PATIENT);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.findPatientByPhone("+420111222333");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Array.isArray(result.data), true);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]!.id, 1);
  }
});

test("listVisits unwraps {data:[...], result:'ok', error:null} into array", async () => {
  const { fetch } = mockFetch(WRAPPED_VISITS);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-01", "2026-07-31");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Array.isArray(result.data), true);
    assert.equal(result.data.length, 1);
  }
});

test("listPayments unwraps {data:[...], result:'ok', error:null} into array", async () => {
  const wrappedPayments = { data: [{ id: 5, amount: 2500, date: "2026-07-01" }], result: "success", error: null };
  const { fetch } = mockFetch(wrappedPayments);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.listPayments("2026-07-01", "2026-07-31");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Array.isArray(result.data), true);
    assert.equal(result.data.length, 1);
  }
});

test("listVisits returns empty array when wrapped data is []", async () => {
  const { fetch } = mockFetch(WRAPPED_EMPTY);
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-01", "2026-07-31");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Array.isArray(result.data), true);
    assert.equal(result.data.length, 0);
  }
});

test("API envelope error returns ok:false with code cliniccard_api_error", async () => {
  const { fetch } = mockFetch({ data: null, result: "error", error: "Access denied" });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-01", "2026-07-31");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_api_error");
    assert.match(result.error.message, /Access denied/);
  }
});

test("API envelope error message does not expose token", async () => {
  const { fetch } = mockFetch({ data: null, result: "error", error: `Auth failed: ${TEST_CONFIG.api_token}` });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-01", "2026-07-31");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.error.message, new RegExp(TEST_CONFIG.api_token));
    assert.match(result.error.message, /\[REDACTED\]/);
  }
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

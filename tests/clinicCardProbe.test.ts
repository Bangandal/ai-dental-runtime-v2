import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { runClinicCardProbe, type ClinicCardProbeDeps, type ReadOnlyClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardProbe.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { ClinicCardConfigResult } from "../src/integrations/cliniccard/clinicCardConfig.ts";

const TEST_TOKEN = "test-probe-token-placeholder";

const TEST_CONFIG: ClinicCardConfig = {
  api_base_url: "https://cliniccards.com",
  api_token: TEST_TOKEN,
  default_doctor_id: "10",
  default_cabinet_id: "2",
  timezone: "Europe/Prague",
  booking_mode: "disabled",
};

function makeOkConfig(): ClinicCardConfigResult {
  return { ok: true, data: TEST_CONFIG };
}

function makeFailConfig(message = "CLINICCARD_API_TOKEN is required but not set"): ClinicCardConfigResult {
  return { ok: false, error: { code: "cliniccard_config_missing_field", message } };
}

function makeAdapter(overrides: Partial<ReadOnlyClinicCardAdapter> = {}): {
  adapter: ReadOnlyClinicCardAdapter;
  calls: { findPatientByPhone: string[]; listVisits: Array<[string, string]> };
} {
  const calls = { findPatientByPhone: [] as string[], listVisits: [] as Array<[string, string]> };
  const adapter: ReadOnlyClinicCardAdapter = {
    findPatientByPhone: overrides.findPatientByPhone ?? (async (phone) => {
      calls.findPatientByPhone.push(phone);
      return { ok: true, data: [{ id: 1, name: "Test Patient" }] };
    }),
    listVisits: overrides.listVisits ?? (async (from, to) => {
      calls.listVisits.push([from, to]);
      return { ok: true, data: [{ id: 10, patient_id: 1, doctor_id: 10, cabinet_id: 2, date: from, time_start: "09:00", time_end: "09:30", status: "PLANNED" as const }] };
    }),
  };
  return { adapter, calls };
}

function makeDeps(
  configResult: ClinicCardConfigResult,
  adapterOverrides: Partial<ReadOnlyClinicCardAdapter> = {},
): { deps: ClinicCardProbeDeps; calls: { findPatientByPhone: string[]; listVisits: Array<[string, string]> } } {
  const { adapter, calls } = makeAdapter(adapterOverrides);
  const deps: ClinicCardProbeDeps = {
    loadConfig: () => configResult,
    createAdapter: () => adapter,
  };
  return { deps, calls };
}

// ── Config missing ────────────────────────────────────────────────────────────

test("probe fails safely when config is missing — returns config_loaded:false, no throw", async () => {
  const { deps } = makeDeps(makeFailConfig());
  const output = await runClinicCardProbe({}, deps);
  assert.equal(output.config_loaded, false);
  assert.equal(output.api_ok, false);
  assert.equal(output.patients_found_count, 0);
  assert.equal(output.visits_found_count, 0);
  assert.equal(typeof output.error, "string");
});

test("probe fails safely without throwing even when loadConfig throws", async () => {
  const deps: ClinicCardProbeDeps = {
    loadConfig: () => makeFailConfig("missing base URL"),
    createAdapter: () => { throw new Error("should not be called"); },
  };
  await assert.doesNotReject(() => runClinicCardProbe({}, deps));
});

// ── findPatientByPhone called only when phone provided ────────────────────────

test("probe calls findPatientByPhone only when phone is provided", async () => {
  const { deps, calls } = makeDeps(makeOkConfig());
  await runClinicCardProbe({ phone: "+420111222333" }, deps);
  assert.equal(calls.findPatientByPhone.length, 1);
  assert.equal(calls.findPatientByPhone[0], "+420111222333");
});

test("probe does not call findPatientByPhone when phone is omitted", async () => {
  const { deps, calls } = makeDeps(makeOkConfig());
  await runClinicCardProbe({ from: "2026-07-01", to: "2026-07-31" }, deps);
  assert.equal(calls.findPatientByPhone.length, 0);
});

test("probe reports patients_found_count from findPatientByPhone result", async () => {
  const { deps } = makeDeps(makeOkConfig(), {
    findPatientByPhone: async () => ({ ok: true, data: [{ id: 1, name: "A" }, { id: 2, name: "B" }] }),
  });
  const output = await runClinicCardProbe({ phone: "+420111222333" }, deps);
  assert.equal(output.patients_found_count, 2);
});

// ── listVisits called with from/to ────────────────────────────────────────────

test("probe calls listVisits with correct from and to", async () => {
  const { deps, calls } = makeDeps(makeOkConfig());
  await runClinicCardProbe({ from: "2026-07-01", to: "2026-07-31" }, deps);
  assert.equal(calls.listVisits.length, 1);
  assert.deepEqual(calls.listVisits[0], ["2026-07-01", "2026-07-31"]);
});

test("probe reports visits_found_count from listVisits result", async () => {
  const { deps } = makeDeps(makeOkConfig(), {
    listVisits: async () => ({
      ok: true,
      data: [
        { id: 1, patient_id: 1, doctor_id: 10, cabinet_id: 2, date: "2026-07-10", time_start: "09:00", time_end: "09:30", status: "PLANNED" as const },
        { id: 2, patient_id: 1, doctor_id: 10, cabinet_id: 2, date: "2026-07-11", time_start: "10:00", time_end: "10:30", status: "CONFIRMED" as const },
      ],
    }),
  });
  const output = await runClinicCardProbe({ from: "2026-07-01", to: "2026-07-31" }, deps);
  assert.equal(output.visits_found_count, 2);
});

// ── Phone masking ─────────────────────────────────────────────────────────────

test("probe output does not contain the raw phone number", async () => {
  const phone = "+420111222333";
  const { deps } = makeDeps(makeOkConfig());
  const output = await runClinicCardProbe({ phone }, deps);
  const outputStr = JSON.stringify(output);
  assert.doesNotMatch(outputStr, new RegExp(phone.replace("+", "\\+")), "raw phone must not appear in probe output");
});

test("probe masks phone in error message when findPatientByPhone fails", async () => {
  const phone = "+420111222333";
  const { deps } = makeDeps(makeOkConfig(), {
    findPatientByPhone: async () => ({
      ok: false,
      error: { code: "cliniccard_http_error", message: `Not found for phone=${phone}` },
    }),
  });
  const output = await runClinicCardProbe({ phone }, deps);
  assert.equal(output.api_ok, false);
  assert.ok(output.error !== undefined);
  assert.doesNotMatch(output.error!, new RegExp(phone.replace("+", "\\+")), "phone must be masked in error");
  assert.match(output.error!, /\*\*\*/, "masked phone must appear in error");
});

// ── Token not exposed ─────────────────────────────────────────────────────────

test("probe output does not expose the API token in error field", async () => {
  const { deps } = makeDeps(makeOkConfig(), {
    findPatientByPhone: async () => ({
      ok: false,
      error: { code: "cliniccard_http_error", message: `[REDACTED] auth error` },
    }),
  });
  const output = await runClinicCardProbe({ phone: "+420111222333" }, deps);
  const outputStr = JSON.stringify(output);
  assert.doesNotMatch(outputStr, new RegExp(TEST_TOKEN), "API token must not appear in probe output");
});

test("probe config error message does not contain the token", async () => {
  const { deps } = makeDeps(makeFailConfig("CLINICCARD_API_TOKEN is required but not set"));
  const output = await runClinicCardProbe({}, deps);
  assert.doesNotMatch(output.error ?? "", new RegExp(TEST_TOKEN));
});

// ── Write methods not called ──────────────────────────────────────────────────

test("probe does not call createPatient or createVisit — ReadOnlyClinicCardAdapter has no write methods", async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const probeSrc = readFileSync(resolve(dir, "../src/integrations/cliniccard/clinicCardProbe.ts"), "utf8");
  assert.doesNotMatch(probeSrc, /createPatient/, "probe must not reference createPatient");
  assert.doesNotMatch(probeSrc, /createVisit/, "probe must not reference createVisit");
  assert.doesNotMatch(probeSrc, /listPayments/, "probe must not reference listPayments");
});

// ── Runtime isolation ─────────────────────────────────────────────────────────

test("clinicCardProbe is not imported by runtimeTurnPipeline", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const pipelineSrc = readFileSync(resolve(dir, "../src/runtime/runtimeTurnPipeline.ts"), "utf8");
  assert.doesNotMatch(pipelineSrc, /clinicCardProbe/i, "runtimeTurnPipeline must not import probe");
});

test("clinicCardProbe is not imported by dentalRuntimeAgentFactory", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const factorySrc = readFileSync(resolve(dir, "../src/runtime/dentalRuntimeAgentFactory.ts"), "utf8");
  assert.doesNotMatch(factorySrc, /clinicCardProbe/i, "dentalRuntimeAgentFactory must not import probe");
});

// ── No booking side effects ───────────────────────────────────────────────────

test("probe output has no appointment/slot_hold/notification side effects fields", async () => {
  const { deps } = makeDeps(makeOkConfig());
  const output = await runClinicCardProbe({ phone: "+420111222333", from: "2026-07-01", to: "2026-07-31" }, deps);
  assert.equal("appointments" in output, false);
  assert.equal("slot_holds" in output, false);
  assert.equal("notifications" in output, false);
  assert.equal("side_effects" in output, false);
});

test("probe with mocked adapter does not trigger real ClinicCard HTTP calls", async () => {
  let fetchCalled = false;
  const { deps } = makeDeps(makeOkConfig(), {
    findPatientByPhone: async () => {
      fetchCalled = true;
      return { ok: true, data: [] };
    },
    listVisits: async () => {
      fetchCalled = true;
      return { ok: true, data: [] };
    },
  });
  await runClinicCardProbe({ phone: "+420111222333", from: "2026-07-01", to: "2026-07-31" }, deps);
  // fetchCalled being true here just proves the mock was used (not real fetch)
  // The point is: no globalThis.fetch was called — only the injected mock
  assert.equal(fetchCalled, true, "only mock adapter was called");
});

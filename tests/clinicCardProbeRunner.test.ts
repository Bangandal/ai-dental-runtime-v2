import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { parseCliArgs, runProbeRunner } from "../scripts/cliniccard-probe.ts";
import type { ClinicCardProbeDeps, ReadOnlyClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardProbe.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";

const TEST_TOKEN = "runner-test-token-placeholder";

const TEST_CONFIG: ClinicCardConfig = {
  api_base_url: "https://cliniccards.com",
  api_token: TEST_TOKEN,
  default_doctor_id: "10",
  default_cabinet_id: "2",
  timezone: "Europe/Prague",
  booking_mode: "disabled",
};

function makeAdapter(overrides: Partial<ReadOnlyClinicCardAdapter> = {}): {
  adapter: ReadOnlyClinicCardAdapter;
  callLog: { findPatientByPhone: string[]; listVisits: Array<[string, string]> };
} {
  const callLog = { findPatientByPhone: [] as string[], listVisits: [] as Array<[string, string]> };
  const adapter: ReadOnlyClinicCardAdapter = {
    findPatientByPhone: overrides.findPatientByPhone ?? (async (phone) => {
      callLog.findPatientByPhone.push(phone);
      return { ok: true, data: [] };
    }),
    listVisits: overrides.listVisits ?? (async (from, to) => {
      callLog.listVisits.push([from, to]);
      return { ok: true, data: [] };
    }),
  };
  return { adapter, callLog };
}

function makeOkDeps(overrides: Partial<ReadOnlyClinicCardAdapter> = {}): {
  deps: ClinicCardProbeDeps;
  callLog: { findPatientByPhone: string[]; listVisits: Array<[string, string]> };
} {
  const { adapter, callLog } = makeAdapter(overrides);
  const deps: ClinicCardProbeDeps = {
    loadConfig: () => ({ ok: true, data: TEST_CONFIG }),
    createAdapter: () => adapter,
  };
  return { deps, callLog };
}

function makeFailDeps(): ClinicCardProbeDeps {
  return {
    loadConfig: () => ({ ok: false, error: { code: "cliniccard_config_missing_field", message: "CLINICCARD_API_TOKEN is required but not set" } }),
    createAdapter: () => { throw new Error("should not be called"); },
  };
}

function captureOutput(): { lines: string[]; writeLine: (text: string) => void } {
  const lines: string[] = [];
  return { lines, writeLine: (text) => lines.push(text) };
}

// ── parseCliArgs ──────────────────────────────────────────────────────────────

test("parseCliArgs parses --phone, --from, --to", () => {
  const result = parseCliArgs(["--phone=+420111222333", "--from=2026-07-01", "--to=2026-07-07"]);
  assert.equal(result.phone, "+420111222333");
  assert.equal(result.from, "2026-07-01");
  assert.equal(result.to, "2026-07-07");
});

test("parseCliArgs ignores unrecognized flags", () => {
  const result = parseCliArgs(["--foo=bar", "--from=2026-07-01"]);
  assert.equal(result.from, "2026-07-01");
  assert.equal(result.phone, undefined);
  assert.equal(result.to, undefined);
});

test("parseCliArgs returns empty object when no args", () => {
  const result = parseCliArgs([]);
  assert.deepEqual(result, {});
});

// ── Runner calls probe with parsed args ───────────────────────────────────────

test("runner calls findPatientByPhone with parsed phone", async () => {
  const { deps, callLog } = makeOkDeps();
  const { writeLine } = captureOutput();
  await runProbeRunner(["--phone=+420111222333"], deps, writeLine);
  assert.equal(callLog.findPatientByPhone.length, 1);
  assert.equal(callLog.findPatientByPhone[0], "+420111222333");
});

test("runner calls listVisits with parsed from and to", async () => {
  const { deps, callLog } = makeOkDeps();
  const { writeLine } = captureOutput();
  await runProbeRunner(["--from=2026-07-01", "--to=2026-07-07"], deps, writeLine);
  assert.equal(callLog.listVisits.length, 1);
  assert.deepEqual(callLog.listVisits[0], ["2026-07-01", "2026-07-07"]);
});

// ── Output does not expose sensitive data ─────────────────────────────────────

test("output does not include raw phone number", async () => {
  const phone = "+420111222333";
  const { deps } = makeOkDeps();
  const { lines, writeLine } = captureOutput();
  await runProbeRunner([`--phone=${phone}`], deps, writeLine);
  const output = lines.join("");
  assert.doesNotMatch(output, new RegExp(phone.replace("+", "\\+")), "raw phone must not appear in runner output");
});

test("output does not include the API token", async () => {
  const { deps } = makeOkDeps({
    findPatientByPhone: async () => ({
      ok: false,
      error: { code: "cliniccard_http_error", message: "[REDACTED] auth failed" },
    }),
  });
  const { lines, writeLine } = captureOutput();
  await runProbeRunner(["--phone=+420111222333"], deps, writeLine);
  const output = lines.join("");
  assert.doesNotMatch(output, new RegExp(TEST_TOKEN), "token must not appear in runner output");
});

test("output does not include patient names", async () => {
  const { deps } = makeOkDeps({
    findPatientByPhone: async () => ({
      ok: true,
      data: [{ id: 1, name: "Jana Procházková", phone: "+420777888999" }],
    }),
  });
  const { lines, writeLine } = captureOutput();
  await runProbeRunner(["--phone=+420111222333"], deps, writeLine);
  const output = lines.join("");
  assert.doesNotMatch(output, /Jana Procházková/, "patient name must not appear in runner output");
  assert.doesNotMatch(output, /Jana/, "patient name must not appear in runner output");
});

test("output contains only count and status fields", async () => {
  const { deps } = makeOkDeps();
  const { lines, writeLine } = captureOutput();
  await runProbeRunner(["--from=2026-07-01", "--to=2026-07-07"], deps, writeLine);
  const parsed = JSON.parse(lines[0]!);
  const allowedKeys = new Set(["config_loaded", "api_ok", "patients_found_count", "visits_found_count", "error"]);
  for (const key of Object.keys(parsed)) {
    assert.ok(allowedKeys.has(key), `unexpected key in output: ${key}`);
  }
});

// ── Runner does not call write methods ────────────────────────────────────────

test("runner script does not reference createPatient or createVisit", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(dir, "../scripts/cliniccard-probe.ts"), "utf8");
  assert.doesNotMatch(src, /createPatient/, "runner must not call createPatient");
  assert.doesNotMatch(src, /createVisit/, "runner must not call createVisit");
  assert.doesNotMatch(src, /listPayments/, "runner must not call listPayments");
});

// ── Fails safely when config missing ─────────────────────────────────────────

test("runner fails safely when config is missing — no throw, exitCode 1", async () => {
  const { lines, writeLine } = captureOutput();
  const { output, exitCode } = await runProbeRunner([], makeFailDeps(), writeLine);
  assert.equal(output.config_loaded, false);
  assert.equal(output.api_ok, false);
  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1, "runner must print exactly one JSON line");
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.config_loaded, false);
});

test("runner fails safely even when probe throws unexpectedly — no throw", async () => {
  const deps: ClinicCardProbeDeps = {
    loadConfig: () => ({ ok: true, data: TEST_CONFIG }),
    createAdapter: () => {
      throw new Error("unexpected internal error");
    },
  };
  const { writeLine } = captureOutput();
  await assert.doesNotReject(() => runProbeRunner(["--phone=+420111222333"], deps, writeLine));
});

// ── Runtime isolation ─────────────────────────────────────────────────────────

test("cliniccard probe runner is not imported by runtimeTurnPipeline", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(dir, "../src/runtime/runtimeTurnPipeline.ts"), "utf8");
  assert.doesNotMatch(src, /cliniccard-probe/i, "runtimeTurnPipeline must not import probe runner");
});

// ── No runtime booking side effects ──────────────────────────────────────────

test("runner output has no appointment/slot_hold/notification fields", async () => {
  const { deps } = makeOkDeps();
  const { lines, writeLine } = captureOutput();
  await runProbeRunner(["--from=2026-07-01", "--to=2026-07-07"], deps, writeLine);
  const parsed = JSON.parse(lines[0]!);
  assert.equal("appointments" in parsed, false);
  assert.equal("slot_holds" in parsed, false);
  assert.equal("notifications" in parsed, false);
  assert.equal("side_effects" in parsed, false);
});

test("runner returns exitCode 0 on success", async () => {
  const { deps } = makeOkDeps();
  const { writeLine } = captureOutput();
  const { exitCode } = await runProbeRunner(["--from=2026-07-01", "--to=2026-07-07"], deps, writeLine);
  assert.equal(exitCode, 0);
});

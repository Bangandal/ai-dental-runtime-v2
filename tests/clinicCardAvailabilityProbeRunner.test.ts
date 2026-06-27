import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  parseAvailabilityArgs,
  runAvailabilityProbeRunner,
} from "../scripts/cliniccard-availability-probe.ts";
import type { AvailabilityProbeDeps } from "../scripts/cliniccard-availability-probe.ts";
import type { ClinicCardConfig, ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";

const TEST_TOKEN = "avail-probe-test-token";

const TEST_CONFIG: ClinicCardConfig = {
  api_base_url: "https://cliniccards.com",
  api_token: TEST_TOKEN,
  default_doctor_id: "10",
  default_cabinet_id: "2",
  timezone: "Europe/Prague",
  booking_mode: "disabled",
};

const BASE_ARGV = [
  "--date=2026-07-01",
  "--doctor-id=10",
  "--cabinet-id=2",
  "--working-hours-start=09:00",
  "--working-hours-end=12:00",
  "--duration-minutes=30",
];

function makeVisit(overrides: Partial<ClinicCardVisit> = {}): ClinicCardVisit {
  return {
    id: 1,
    patient_id: 99,
    doctor_id: 10,
    cabinet_id: 2,
    date: "2026-07-01",
    time_start: "09:00",
    time_end: "09:30",
    status: "PLANNED",
    ...overrides,
  };
}

function makeOkDeps(visits: ClinicCardVisit[] = []): AvailabilityProbeDeps {
  return {
    loadConfig: () => ({ ok: true, data: TEST_CONFIG }),
    createAdapter: () => ({
      listVisits: async () => ({ ok: true, data: visits }),
    }),
  };
}

function makeConfigFailDeps(): AvailabilityProbeDeps {
  return {
    loadConfig: () => ({
      ok: false,
      error: { code: "cliniccard_config_missing_field", message: "CLINICCARD_API_TOKEN is required but not set" },
    }),
    createAdapter: () => { throw new Error("should not be called"); },
  };
}

function makeApiErrorDeps(): AvailabilityProbeDeps {
  return {
    loadConfig: () => ({ ok: true, data: TEST_CONFIG }),
    createAdapter: () => ({
      listVisits: async () => ({
        ok: false,
        error: { code: "cliniccard_http_error", message: "HTTP 401: Unauthorized" },
      }),
    }),
  };
}

function capture(): { lines: string[]; writeLine: (t: string) => void } {
  const lines: string[] = [];
  return { lines, writeLine: (t) => lines.push(t) };
}

// ── Strict numeric validation ─────────────────────────────────────────────────

test("--doctor-id=10abc is rejected — strict int parse", () => {
  const args = parseAvailabilityArgs(["--doctor-id=10abc"]);
  assert.equal(args.doctor_id, undefined, "10abc must not parse as 10");
});

test("--cabinet-id=2x is rejected — strict int parse", () => {
  const args = parseAvailabilityArgs(["--cabinet-id=2x"]);
  assert.equal(args.cabinet_id, undefined, "2x must not parse as 2");
});

test("--duration-minutes=30min is rejected — strict int parse", () => {
  const args = parseAvailabilityArgs(["--duration-minutes=30min"]);
  assert.equal(args.duration_minutes, undefined, "30min must not parse as 30");
});

test("--duration-minutes=30.5 is rejected — not an integer", () => {
  const args = parseAvailabilityArgs(["--duration-minutes=30.5"]);
  assert.equal(args.duration_minutes, undefined, "30.5 must be rejected");
});

test("--doctor-id=-1 is rejected — not positive", () => {
  const args = parseAvailabilityArgs(["--doctor-id=-1"]);
  assert.equal(args.doctor_id, undefined);
});

test("--cabinet-id=0 is rejected — not positive", () => {
  const args = parseAvailabilityArgs(["--cabinet-id=0"]);
  assert.equal(args.cabinet_id, undefined);
});

test("invalid --doctor-id does not call createAdapter or listVisits", async () => {
  let adapterCalled = false;
  const deps: AvailabilityProbeDeps = {
    loadConfig: () => ({ ok: true, data: TEST_CONFIG }),
    createAdapter: () => {
      adapterCalled = true;
      return { listVisits: async () => ({ ok: true, data: [] }) };
    },
  };
  const argv = ["--date=2026-07-01", "--doctor-id=10abc", "--cabinet-id=2", "--duration-minutes=30"];
  const { writeLine } = capture();
  const { output, exitCode } = await runAvailabilityProbeRunner(argv, deps, writeLine);
  assert.equal(adapterCalled, false, "createAdapter must not be called for invalid doctor_id");
  assert.equal(output.availability_ok, false);
  assert.equal(exitCode, 1);
});

test("invalid numeric arg produces sanitized output — only allowed fields, error set", async () => {
  const argv = ["--date=2026-07-01", "--doctor-id=10abc", "--cabinet-id=2", "--duration-minutes=30"];
  const { lines, writeLine } = capture();
  await runAvailabilityProbeRunner(argv, makeOkDeps(), writeLine);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.availability_ok, false);
  assert.ok(typeof parsed.error === "string" && parsed.error.length > 0);
  const allowed = new Set(["config_loaded", "api_ok", "availability_ok", "total_slots", "free_slots_count", "sample_slots", "error"]);
  for (const key of Object.keys(parsed)) {
    assert.ok(allowed.has(key), `unexpected key: ${key}`);
  }
});

// ── parseAvailabilityArgs ─────────────────────────────────────────────────────

test("parseAvailabilityArgs parses all supported flags", () => {
  const args = parseAvailabilityArgs([
    "--date=2026-07-01",
    "--date-to=2026-07-07",
    "--doctor-id=10",
    "--cabinet-id=2",
    "--working-hours-start=09:00",
    "--working-hours-end=18:00",
    "--duration-minutes=30",
    "--timezone=Europe/Prague",
  ]);
  assert.equal(args.date, "2026-07-01");
  assert.equal(args.date_to, "2026-07-07");
  assert.equal(args.doctor_id, 10);
  assert.equal(args.cabinet_id, 2);
  assert.equal(args.working_hours_start, "09:00");
  assert.equal(args.working_hours_end, "18:00");
  assert.equal(args.duration_minutes, 30);
  assert.equal(args.timezone, "Europe/Prague");
});

test("parseAvailabilityArgs returns empty object for no args", () => {
  const args = parseAvailabilityArgs([]);
  assert.deepEqual(args, {});
});

test("parseAvailabilityArgs ignores unknown flags", () => {
  const args = parseAvailabilityArgs(["--foo=bar", "--date=2026-07-01"]);
  assert.equal(args.date, "2026-07-01");
  assert.equal((args as Record<string, unknown>).foo, undefined);
});

// ── Runner calls listVisits ───────────────────────────────────────────────────

test("runner calls listVisits through adapter with correct date range", async () => {
  const calls: Array<[string, string]> = [];
  const deps: AvailabilityProbeDeps = {
    loadConfig: () => ({ ok: true, data: TEST_CONFIG }),
    createAdapter: () => ({
      listVisits: async (from, to) => {
        calls.push([from, to]);
        return { ok: true, data: [] };
      },
    }),
  };
  const { writeLine } = capture();
  await runAvailabilityProbeRunner(BASE_ARGV, deps, writeLine);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], "2026-07-01");
  assert.equal(calls[0]![1], "2026-07-01");
});

// ── Runner does not call write methods ────────────────────────────────────────

test("runner source does not reference createPatient, createVisit, or listPayments", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(dir, "../scripts/cliniccard-availability-probe.ts"), "utf8");
  assert.doesNotMatch(src, /createPatient/, "must not reference createPatient");
  assert.doesNotMatch(src, /createVisit/, "must not reference createVisit");
  assert.doesNotMatch(src, /listPayments/, "must not reference listPayments");
});

// ── Output fields ─────────────────────────────────────────────────────────────

test("output contains only allowed fields", async () => {
  const { lines, writeLine } = capture();
  await runAvailabilityProbeRunner(BASE_ARGV, makeOkDeps(), writeLine);
  const parsed = JSON.parse(lines[0]!);
  const allowed = new Set(["config_loaded", "api_ok", "availability_ok", "total_slots", "free_slots_count", "sample_slots", "error"]);
  for (const key of Object.keys(parsed)) {
    assert.ok(allowed.has(key), `unexpected key in output: ${key}`);
  }
});

test("output does not include token, raw phone, patient names, patient_id, or raw visits", async () => {
  const visits = [makeVisit({ patient_id: 42 })];
  const { lines, writeLine } = capture();
  await runAvailabilityProbeRunner(BASE_ARGV, makeOkDeps(visits), writeLine);
  const outputStr = lines.join("");
  assert.doesNotMatch(outputStr, new RegExp(TEST_TOKEN), "token must not appear in output");
  assert.doesNotMatch(outputStr, /patient_id/, "patient_id must not appear in output");
  assert.doesNotMatch(outputStr, /\+420/, "raw phone must not appear in output");
});

test("sample_slots contains at most 5 slots", async () => {
  // 09:00-18:00 / 30min = 18 slots but we cap at 5
  const deps = makeOkDeps([]);
  const argv = ["--date=2026-07-01", "--doctor-id=10", "--cabinet-id=2",
    "--working-hours-start=09:00", "--working-hours-end=18:00", "--duration-minutes=30"];
  const { lines, writeLine } = capture();
  await runAvailabilityProbeRunner(argv, deps, writeLine);
  const parsed = JSON.parse(lines[0]!);
  assert.ok(parsed.sample_slots.length <= 5, "sample_slots must be at most 5");
});

test("sample_slots entries contain only date, time_start, time_end", async () => {
  const { lines, writeLine } = capture();
  await runAvailabilityProbeRunner(BASE_ARGV, makeOkDeps(), writeLine);
  const parsed = JSON.parse(lines[0]!);
  for (const slot of parsed.sample_slots) {
    assert.deepEqual(Object.keys(slot).sort(), ["date", "time_end", "time_start"]);
  }
});

// ── Invalid duration ──────────────────────────────────────────────────────────

test("invalid duration (0) returns availability_ok:false, exitCode 1, does not hang", async () => {
  const argv = [...BASE_ARGV.filter(a => !a.startsWith("--duration")), "--duration-minutes=0"];
  const { lines, writeLine } = capture();
  const { output, exitCode } = await runAvailabilityProbeRunner(argv, makeOkDeps(), writeLine);
  assert.equal(output.availability_ok, false);
  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1);
});

test("invalid duration (-30) returns availability_ok:false, exitCode 1", async () => {
  const argv = [...BASE_ARGV.filter(a => !a.startsWith("--duration")), "--duration-minutes=-30"];
  const { lines, writeLine } = capture();
  const { output, exitCode } = await runAvailabilityProbeRunner(argv, makeOkDeps(), writeLine);
  assert.equal(output.availability_ok, false);
  assert.equal(exitCode, 1);
});

// ── API error ─────────────────────────────────────────────────────────────────

test("ClinicCard API error returns availability_ok:false, api_ok:false, exitCode 1", async () => {
  const { lines, writeLine } = capture();
  const { output, exitCode } = await runAvailabilityProbeRunner(BASE_ARGV, makeApiErrorDeps(), writeLine);
  assert.equal(output.api_ok, false);
  assert.equal(output.availability_ok, false);
  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.availability_ok, false);
});

// ── Config missing ────────────────────────────────────────────────────────────

test("missing config returns config_loaded:false, exitCode 1", async () => {
  const { lines, writeLine } = capture();
  const { output, exitCode } = await runAvailabilityProbeRunner(BASE_ARGV, makeConfigFailDeps(), writeLine);
  assert.equal(output.config_loaded, false);
  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1);
});

// ── Success ───────────────────────────────────────────────────────────────────

test("successful probe returns exitCode 0 and expected output shape", async () => {
  const { lines, writeLine } = capture();
  const { exitCode } = await runAvailabilityProbeRunner(BASE_ARGV, makeOkDeps(), writeLine);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.config_loaded, true);
  assert.equal(parsed.api_ok, true);
  assert.equal(parsed.availability_ok, true);
  assert.equal(typeof parsed.total_slots, "number");
  assert.equal(typeof parsed.free_slots_count, "number");
  assert.ok(Array.isArray(parsed.sample_slots));
  assert.equal(parsed.error, null);
});

// ── Runtime isolation ─────────────────────────────────────────────────────────

test("runner source does not import runtimeTurnPipeline or dentalRuntimeAgentFactory", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(dir, "../scripts/cliniccard-availability-probe.ts"), "utf8");
  assert.doesNotMatch(src, /runtimeTurnPipeline/, "must not import runtimeTurnPipeline");
  assert.doesNotMatch(src, /dentalRuntimeAgentFactory/, "must not import dentalRuntimeAgentFactory");
});

test("runner source does not reference booking.apply, slot_hold, handoff.create, or admin.notify", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(dir, "../scripts/cliniccard-availability-probe.ts"), "utf8");
  assert.doesNotMatch(src, /booking\.apply/, "must not reference booking.apply");
  assert.doesNotMatch(src, /slot_hold/, "must not reference slot_hold");
  assert.doesNotMatch(src, /handoff\.create/, "must not reference handoff.create");
  assert.doesNotMatch(src, /admin\.notify/, "must not reference admin.notify");
});

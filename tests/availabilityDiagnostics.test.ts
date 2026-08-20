import assert from "node:assert/strict";
import test from "node:test";

import { isAvailabilityDebugEnabled, toVisitSample } from "../src/integrations/cliniccard/availabilityDiagnostics.ts";
import { checkClinicCardAvailability } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { AvailabilityAdapter } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const BASE_INPUT = {
  date: "2026-07-08",
  working_hours_start: "09:00",
  working_hours_end: "12:00",
  slot_duration_minutes: 30,
  doctor_id: 42,
  cabinet_id: 7,
  timezone: "Europe/Prague",
};

function makeVisit(overrides: Partial<ClinicCardVisit>): ClinicCardVisit {
  return {
    id: 1,
    patient_id: 99,
    doctor_id: 42,
    cabinet_id: 7,
    date: "2026-07-08",
    time_start: "09:00",
    time_end: "09:30",
    status: "PLANNED",
    ...overrides,
  };
}

function makeAdapter(visits: ClinicCardVisit[]): AvailabilityAdapter {
  return { listVisits: async () => ({ ok: true, data: visits }) };
}

const BASE_EXECUTOR_ENV: Record<string, string | undefined> = {
  CLINICCARD_API_BASE_URL: "https://test.example.com",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_DEFAULT_DOCTOR_ID: "42",
  CLINICCARD_DEFAULT_CABINET_ID: "7",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_HOLIDAYS: "",
};

const BASE_CONTEXT: ToolExecutionContext = {
  clinic_id: "clinic_1",
  requested_date: "2026-07-08",
};

test("A: isAvailabilityDebugEnabled returns false when env flag not set", () => {
  assert.equal(isAvailabilityDebugEnabled({}), false);
});

test("A: isAvailabilityDebugEnabled returns false when flag is 'false'", () => {
  assert.equal(isAvailabilityDebugEnabled({ CLINICCARD_AVAILABILITY_DEBUG: "false" }), false);
});

test("A: isAvailabilityDebugEnabled returns false when flag is '1'", () => {
  assert.equal(isAvailabilityDebugEnabled({ CLINICCARD_AVAILABILITY_DEBUG: "1" }), false);
});

test("A: checkClinicCardAvailability returns no diagnostic when debug not set", async () => {
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: false }, makeAdapter([]));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.diagnostic, undefined);
});

test("B: isAvailabilityDebugEnabled returns true when CLINICCARD_AVAILABILITY_DEBUG=true", () => {
  assert.equal(isAvailabilityDebugEnabled({ CLINICCARD_AVAILABILITY_DEBUG: "true" }), true);
});

test("B: debug enabled returns diagnostic with correct counts (no visits)", async () => {
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic;
    assert.ok(d, "diagnostic must be present");
    assert.equal(d!.requested_date, "2026-07-08");
    assert.equal(d!.timezone, "Europe/Prague");
    assert.equal(d!.doctor_id, 42);
    assert.equal(d!.cabinet_id, 7);
    assert.equal(d!.working_hours_start, "09:00");
    assert.equal(d!.working_hours_end, "12:00");
    assert.equal(d!.slot_duration_minutes, 30);
    assert.equal(d!.raw_visits_count, 0);
    assert.equal(d!.relevant_visits_count, 0);
    assert.equal(d!.total_slots, 6);
    assert.equal(d!.blocked_slots_count, 0);
    assert.equal(d!.free_slots_count_before_filters, 6);
    assert.deepEqual(d!.relevant_visits_sample, []);
  }
});

test("C: visit with matching doctor_id blocks its slot, blocked_slots_count increments", async () => {
  const visit = makeVisit({ doctor_id: 42, cabinet_id: 99, time_start: "10:00", time_end: "10:30" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.blocked_slots_count, 1);
    assert.equal(d.relevant_visits_count, 1);
    assert.equal(result.data.slots.find((s) => s.time_start === "10:00"), undefined);
    assert.equal(result.data.free_slots_count, 5);
  }
});

test("C: two visits with matching doctor_id block two slots", async () => {
  const visits = [
    makeVisit({ doctor_id: 42, cabinet_id: 99, time_start: "09:00", time_end: "09:30" }),
    makeVisit({ id: 2, doctor_id: 42, cabinet_id: 99, time_start: "11:00", time_end: "11:30" }),
  ];
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter(visits));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.blocked_slots_count, 2);
    assert.equal(d.relevant_visits_count, 2);
    assert.equal(result.data.free_slots_count, 4);
  }
});

test("D: visit with matching cabinet_id but different doctor blocks its slot", async () => {
  const visit = makeVisit({ doctor_id: 999, cabinet_id: 7, time_start: "09:30", time_end: "10:00" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.blocked_slots_count, 1);
    assert.equal(d.relevant_visits_count, 1);
    assert.equal(result.data.slots.find((s) => s.time_start === "09:30"), undefined);
  }
});

test("E: visit with different doctor_id AND different cabinet_id does not block any slot", async () => {
  const visit = makeVisit({ doctor_id: 999, cabinet_id: 888, time_start: "09:00", time_end: "09:30" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.raw_visits_count, 1);
    assert.equal(d.relevant_visits_count, 0);
    assert.equal(d.blocked_slots_count, 0);
    assert.equal(result.data.free_slots_count, 6);
  }
});

test("F: half-day visit (09:00-12:00) blocks all 6 slots, free_slots_count=0", async () => {
  const result = await checkClinicCardAvailability(
    { ...BASE_INPUT, debug: true },
    makeAdapter([makeVisit({ time_start: "09:00", time_end: "12:00" })]),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.total_slots, 6);
    assert.equal(d.blocked_slots_count, 6);
    assert.equal(result.data.free_slots_count, 0);
  }
});

test("F: 09:00-10:30 visit (3 slots) leaves 3 slots free", async () => {
  const result = await checkClinicCardAvailability(
    { ...BASE_INPUT, debug: true },
    makeAdapter([makeVisit({ time_start: "09:00", time_end: "10:30" })]),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.diagnostic!.blocked_slots_count, 3);
    assert.equal(result.data.free_slots_count, 3);
  }
});

test("G: toVisitSample strips patient_id and note", () => {
  const sample = toVisitSample(makeVisit({ id: 55, patient_id: 9999, note: "sensitive patient note" }));
  assert.equal("patient_id" in sample, false);
  assert.equal("note" in sample, false);
  assert.equal(sample.visit_id, 55);
  assert.equal(sample.doctor_id, 42);
  assert.equal(sample.status, "PLANNED");
});

test("G: diagnostic object has no PII fields", async () => {
  const result = await checkClinicCardAvailability(
    { ...BASE_INPUT, debug: true },
    makeAdapter([makeVisit({ patient_id: 9999, note: "private" })]),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    const asJson = JSON.stringify(result.data.diagnostic!);
    assert.doesNotMatch(asJson, /patient_id/);
    assert.doesNotMatch(asJson, /"note"/);
    assert.doesNotMatch(asJson, /9999/);
    assert.doesNotMatch(asJson, /phone/);
    assert.doesNotMatch(asJson, /first_name|last_name/);
  }
});

test("H: executor: diagnostic absent when debug is disabled", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  assert.equal((result.data as Record<string, unknown>)["diagnostic"], undefined);
  assert.equal((result as Record<string, unknown>)["_diagnostic"], undefined);
});

test("H: executor: debug enabled stores diagnostic outside model-visible data", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ ...BASE_CONTEXT, limit: 3 });
  assert.equal(result.status, "success");
  assert.equal((result.data as Record<string, unknown>)["diagnostic"], undefined);
  const d = (result as Record<string, unknown>)["_diagnostic"] as Record<string, unknown>;
  assert.ok(d);
  assert.ok(typeof d["free_slots_count_after_requested_time_filter"] === "number");
  assert.ok(typeof d["free_slots_count_after_past_time_filter"] === "number");
  assert.ok(typeof d["limited_slots_count"] === "number");
});

test("I: model-visible data contains only safe availability fields", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([makeVisit({})]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  const data = result.data as Record<string, unknown>;
  const dataJson = JSON.stringify(data);
  for (const field of ["diagnostic", "visit_id", "doctor_id", "cabinet_id", "status", "_diagnostic"]) {
    assert.doesNotMatch(dataJson, new RegExp(`"${field}"`));
  }
  assert.ok(Array.isArray(data["slots"]));
  assert.ok(typeof data["timezone"] === "string");
  assert.ok(typeof data["total_slots"] === "number");
  assert.ok(typeof data["free_slots_count"] === "number");
});

test("J: _diagnostic.relevant_visits_sample strips patient_id and note fields", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([makeVisit({ patient_id: 9999, note: "sensitive note" })]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  const d = (result as Record<string, unknown>)["_diagnostic"] as Record<string, unknown>;
  const sample = d["relevant_visits_sample"] as Record<string, unknown>[];
  assert.ok(Array.isArray(sample) && sample.length > 0);
  for (const v of sample) {
    assert.equal("patient_id" in v, false);
    assert.equal("note" in v, false);
  }
});

test("K: model tool-result data never includes debug internals", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([makeVisit({ doctor_id: 42, cabinet_id: 7 })]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  const modelPayload = JSON.stringify(result.data);
  assert.doesNotMatch(modelPayload, /"visit_id"/);
  assert.doesNotMatch(modelPayload, /"doctor_id"/);
  assert.doesNotMatch(modelPayload, /"cabinet_id"/);
  assert.doesNotMatch(modelPayload, /"status"/);
  assert.doesNotMatch(modelPayload, /"diagnostic"/);
});

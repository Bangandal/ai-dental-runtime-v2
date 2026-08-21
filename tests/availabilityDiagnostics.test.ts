import assert from "node:assert/strict";
import test from "node:test";

import { isAvailabilityDebugEnabled, toVisitSample } from "../src/integrations/cliniccard/availabilityDiagnostics.ts";
import { checkClinicCardAvailability } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { AvailabilityAdapter } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "12:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_CLOSED_DATES: "",
};

const BASE_CONTEXT: ToolExecutionContext = {
  clinic_id: "clinic_1",
  requested_date: "2026-07-08",
};

// ── A. Debug disabled by default ──────────────────────────────────────────────

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
  if (result.ok) {
    assert.equal(result.data.diagnostic, undefined);
  }
});

// ── B. Debug enabled includes counts ──────────────────────────────────────────

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
    assert.equal(d!.total_slots, 6); // 09:00-12:00 / 30min = 6 slots
    assert.equal(d!.blocked_slots_count, 0);
    assert.equal(d!.free_slots_count_before_filters, 6);
    assert.deepEqual(d!.relevant_visits_sample, []);
  }
});

// ── C. Same doctor visit blocks overlapping slots ─────────────────────────────

test("C: visit with matching doctor_id blocks its slot, blocked_slots_count increments", async () => {
  const visit = makeVisit({ doctor_id: 42, cabinet_id: 99, time_start: "10:00", time_end: "10:30" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.blocked_slots_count, 1, "one slot must be blocked by same doctor");
    assert.equal(d.relevant_visits_count, 1);
    // 10:00 slot must not appear in output
    const blocked = result.data.slots.find((s) => s.time_start === "10:00");
    assert.equal(blocked, undefined, "10:00 slot must be absent from free slots");
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

// ── D. Same cabinet visit blocks overlapping slots ────────────────────────────

test("D: visit with matching cabinet_id but different doctor blocks its slot", async () => {
  const visit = makeVisit({ doctor_id: 999, cabinet_id: 7, time_start: "09:30", time_end: "10:00" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.blocked_slots_count, 1, "cabinet-only match must block slot");
    assert.equal(d.relevant_visits_count, 1);
    const blocked = result.data.slots.find((s) => s.time_start === "09:30");
    assert.equal(blocked, undefined, "09:30 slot must be absent");
  }
});

// ── E. Unrelated doctor+cabinet does not block ────────────────────────────────

test("E: visit with different doctor_id AND different cabinet_id does not block any slot", async () => {
  const visit = makeVisit({ doctor_id: 999, cabinet_id: 888, time_start: "09:00", time_end: "09:30" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.raw_visits_count, 1);
    assert.equal(d.relevant_visits_count, 0, "unrelated visit must not be relevant");
    assert.equal(d.blocked_slots_count, 0);
    assert.equal(result.data.free_slots_count, 6);
  }
});

// ── F. Half-day visit reduces free slot count ─────────────────────────────────

test("F: half-day visit (09:00-12:00) blocks all 6 slots, free_slots_count=0", async () => {
  const visit = makeVisit({ time_start: "09:00", time_end: "12:00" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.total_slots, 6);
    assert.equal(d.blocked_slots_count, 6);
    assert.equal(result.data.free_slots_count, 0);
  }
});

test("F: 09:00-10:30 visit (3 slots) leaves 3 slots free in 09:00-12:00 window", async () => {
  const visit = makeVisit({ time_start: "09:00", time_end: "10:30" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    assert.equal(d.blocked_slots_count, 3);
    assert.equal(result.data.free_slots_count, 3);
  }
});

// ── G. No PII in diagnostic ───────────────────────────────────────────────────

test("G: toVisitSample strips patient_id and note", () => {
  const visit: ClinicCardVisit = {
    id: 55,
    patient_id: 9999,
    doctor_id: 42,
    cabinet_id: 7,
    date: "2026-07-08",
    time_start: "09:00",
    time_end: "09:30",
    status: "PLANNED",
    note: "sensitive patient note",
  };
  const sample = toVisitSample(visit);
  assert.equal("patient_id" in sample, false, "patient_id must not be in sample");
  assert.equal("note" in sample, false, "note must not be in sample");
  assert.equal(sample.visit_id, 55);
  assert.equal(sample.doctor_id, 42);
  assert.equal(sample.status, "PLANNED");
});

test("G: diagnostic object has no PII fields", async () => {
  const visit = makeVisit({ patient_id: 9999, note: "private" });
  const result = await checkClinicCardAvailability({ ...BASE_INPUT, debug: true }, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const d = result.data.diagnostic!;
    const asJson = JSON.stringify(d);
    assert.doesNotMatch(asJson, /patient_id/, "patient_id must not appear in diagnostic JSON");
    assert.doesNotMatch(asJson, /"note"/, "note must not appear in diagnostic JSON");
    assert.doesNotMatch(asJson, /9999/, "patient_id value must not appear in diagnostic JSON");
    assert.doesNotMatch(asJson, /phone/, "phone must not appear in diagnostic JSON");
    assert.doesNotMatch(asJson, /first_name|last_name/, "name fields must not appear in diagnostic JSON");
  }
});

// ── Executor-level: post-filter counts ───────────────────────────────────────

// H: debug disabled — no diagnostic anywhere in tool result
test("H: executor: diagnostic absent from data and _diagnostic when CLINICCARD_AVAILABILITY_DEBUG not set", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  const data = result.data as Record<string, unknown>;
  assert.equal(data["diagnostic"], undefined, "diagnostic must not appear in model-visible data");
  const asAny = result as Record<string, unknown>;
  assert.equal(asAny["_diagnostic"], undefined, "_diagnostic must be absent when debug not enabled");
});

// H: debug enabled — diagnostic NOT in model-visible data, IS in _diagnostic
test("H: executor: debug enabled — diagnostic in _diagnostic, NOT in model-visible data", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ ...BASE_CONTEXT, limit: 3 });
  assert.equal(result.status, "success");

  // Model-visible data must NOT contain diagnostic
  const data = result.data as Record<string, unknown>;
  assert.equal(data["diagnostic"], undefined, "diagnostic must not appear in model-visible data");

  // _diagnostic at top level must contain the diagnostic
  const asAny = result as Record<string, unknown>;
  const d = asAny["_diagnostic"] as Record<string, unknown>;
  assert.ok(d, "_diagnostic must be present at top level");
  assert.ok(typeof d["free_slots_count_after_requested_time_filter"] === "number");
  assert.ok(typeof d["free_slots_count_after_past_time_filter"] === "number");
  assert.ok(typeof d["limited_slots_count"] === "number");
});

// I: model-visible data only has slots, timezone, total_slots, free_slots_count
test("I: model-visible data fields are exactly slots/timezone/total_slots/free_slots_count (no visit_id/doctor_id/cabinet_id/status)", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([makeVisit({})]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  const data = result.data as Record<string, unknown>;

  // These fields must NOT appear in model-visible data
  const sensitiveFields = ["diagnostic", "visit_id", "doctor_id", "cabinet_id", "status", "_diagnostic"];
  const dataJson = JSON.stringify(data);
  for (const field of sensitiveFields) {
    assert.doesNotMatch(dataJson, new RegExp(`"${field}"`), `"${field}" must not appear in model-visible data`);
  }

  // Model-visible data must have expected safe fields
  assert.ok(Array.isArray(data["slots"]), "slots must be present");
  assert.ok(typeof data["timezone"] === "string", "timezone must be present");
  assert.ok(typeof data["total_slots"] === "number", "total_slots must be present");
  assert.ok(typeof data["free_slots_count"] === "number", "free_slots_count must be present");
});

// J: relevant_visits_sample in _diagnostic has no patient_id or note
test("J: _diagnostic.relevant_visits_sample strips patient_id and note fields", async () => {
  const visitWithPii = makeVisit({ patient_id: 9999, note: "sensitive note" });
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([visitWithPii]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  const asAny = result as Record<string, unknown>;
  const d = asAny["_diagnostic"] as Record<string, unknown>;
  assert.ok(d, "_diagnostic must be present");
  const sample = d["relevant_visits_sample"] as Record<string, unknown>[];
  assert.ok(Array.isArray(sample) && sample.length > 0, "relevant_visits_sample must be non-empty");
  for (const v of sample) {
    assert.equal("patient_id" in v, false, "patient_id must not appear in relevant_visits_sample");
    assert.equal("note" in v, false, "note must not appear in relevant_visits_sample");
  }
});

// K: model cannot see visit_id/doctor_id/cabinet_id/status via tool result data JSON
test("K: full tool result data JSON contains no visit_id/doctor_id/cabinet_id/status from diagnostic", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_EXECUTOR_ENV, CLINICCARD_AVAILABILITY_DEBUG: "true" },
    adapterFactory: () => makeAdapter([makeVisit({ doctor_id: 42, cabinet_id: 7 })]),
  });
  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  // Only serialize result.data — what the model would receive as function_call_output
  const modelPayload = JSON.stringify(result.data);
  assert.doesNotMatch(modelPayload, /"visit_id"/, "visit_id must not appear in model payload");
  assert.doesNotMatch(modelPayload, /"doctor_id"/, "doctor_id must not appear in model payload");
  assert.doesNotMatch(modelPayload, /"cabinet_id"/, "cabinet_id must not appear in model payload");
  assert.doesNotMatch(modelPayload, /"status"/, "status must not appear in model payload");
  assert.doesNotMatch(modelPayload, /"diagnostic"/, "diagnostic key must not appear in model payload");
});

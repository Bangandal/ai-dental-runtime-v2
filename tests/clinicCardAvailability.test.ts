import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { checkClinicCardAvailability } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { AvailabilityAdapter, AvailabilityInput } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";

const BASE_INPUT: AvailabilityInput = {
  date: "2026-07-01",
  working_hours_start: "09:00",
  working_hours_end: "12:00",
  slot_duration_minutes: 30,
  doctor_id: 10,
  cabinet_id: 2,
  timezone: "Europe/Prague",
};

function makeVisit(overrides: Partial<ClinicCardVisit>): ClinicCardVisit {
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

function makeAdapter(visits: ClinicCardVisit[]): AvailabilityAdapter {
  return {
    listVisits: async () => ({ ok: true, data: visits }),
  };
}

function makeErrorAdapter(message: string): AvailabilityAdapter {
  return {
    listVisits: async () => ({
      ok: false,
      error: { code: "cliniccard_http_error", message },
    }),
  };
}

// ── 1. No visits → all slots free ─────────────────────────────────────────────

test("listVisits result with 0 visits returns all slots free", async () => {
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.free_slots_count, result.data.total_slots);
    assert.equal(result.data.total_slots, 6); // 09:00-12:00 / 30min = 6 slots
    assert.equal(result.data.slots.length, 6);
  }
});

// ── 2. PLANNED visit blocks overlapping slot ───────────────────────────────────

test("PLANNED visit blocks overlapping slot", async () => {
  const visit = makeVisit({ status: "PLANNED", time_start: "09:00", time_end: "09:30" });
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const blocked = result.data.slots.find((s) => s.time_start === "09:00");
    assert.equal(blocked, undefined, "09:00 slot must be blocked by PLANNED visit");
    assert.equal(result.data.free_slots_count, 5);
  }
});

// ── 3. CONFIRMED visit blocks overlapping slot ────────────────────────────────

test("CONFIRMED visit blocks overlapping slot", async () => {
  const visit = makeVisit({ status: "CONFIRMED", time_start: "10:00", time_end: "10:30" });
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const blocked = result.data.slots.find((s) => s.time_start === "10:00");
    assert.equal(blocked, undefined, "10:00 slot must be blocked by CONFIRMED visit");
    assert.equal(result.data.free_slots_count, 5);
  }
});

// ── 4. VISITED visit blocks overlapping slot ──────────────────────────────────

test("VISITED visit blocks overlapping slot", async () => {
  const visit = makeVisit({ status: "VISITED", time_start: "11:00", time_end: "11:30" });
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const blocked = result.data.slots.find((s) => s.time_start === "11:00");
    assert.equal(blocked, undefined, "11:00 slot must be blocked by VISITED visit");
    assert.equal(result.data.free_slots_count, 5);
  }
});

// ── 5. Unknown status blocks by default ───────────────────────────────────────

test("unknown status blocks by default", async () => {
  const visit = makeVisit({ status: "CANCELLED_BY_PATIENT", time_start: "09:30", time_end: "10:00" });
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const blocked = result.data.slots.find((s) => s.time_start === "09:30");
    assert.equal(blocked, undefined, "09:30 slot must be blocked by unknown-status visit");
    assert.equal(result.data.free_slots_count, 5);
  }
});

// ── 6. Back-to-back slots are allowed ─────────────────────────────────────────

test("back-to-back slots are allowed — visit ending at slot start does not block next slot", async () => {
  // Visit 09:00-09:30 should NOT block 09:30-10:00
  const visit = makeVisit({ status: "PLANNED", time_start: "09:00", time_end: "09:30" });
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const nextSlot = result.data.slots.find((s) => s.time_start === "09:30");
    assert.ok(nextSlot, "09:30 slot must be free when visit ends at 09:30");
  }
});

// ── 7. Timezone Europe/Prague respected ───────────────────────────────────────

test("timezone Europe/Prague is accepted and passed through in input", async () => {
  const input: AvailabilityInput = { ...BASE_INPUT, timezone: "Europe/Prague" };
  const result = await checkClinicCardAvailability(input, makeAdapter([]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.total_slots, 6);
  }
});

// ── 8. No write methods called ────────────────────────────────────────────────

test("clinicCardAvailability source does not reference createPatient, createVisit, or listPayments", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    resolve(dir, "../src/integrations/cliniccard/clinicCardAvailability.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /createPatient/, "must not reference createPatient");
  assert.doesNotMatch(src, /createVisit/, "must not reference createVisit");
  assert.doesNotMatch(src, /listPayments/, "must not reference listPayments");
});

// ── 9. No runtime booking side effects ───────────────────────────────────────

test("clinicCardAvailability source does not reference booking.apply, slot_hold, or admin.notify", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    resolve(dir, "../src/integrations/cliniccard/clinicCardAvailability.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /booking\.apply/, "must not reference booking.apply");
  assert.doesNotMatch(src, /slot_hold/, "must not reference slot_hold");
  assert.doesNotMatch(src, /admin\.notify/, "must not reference admin.notify");
  assert.doesNotMatch(src, /handoff\.create/, "must not reference handoff.create");
});

// ── 10. No patient names or raw data in output ────────────────────────────────

test("output contains only slot date/time fields and counts — no patient names or raw visit data", async () => {
  const visit = makeVisit({ patient_id: 42, status: "PLANNED" });
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const outputStr = JSON.stringify(result.data);
    assert.doesNotMatch(outputStr, /patient_id/, "patient_id must not appear in output");
    assert.doesNotMatch(outputStr, /doctor_id/, "doctor_id must not appear in output");
    for (const slot of result.data.slots) {
      assert.ok("date" in slot && "time_start" in slot && "time_end" in slot, "slot must have date/time fields");
      assert.equal(Object.keys(slot).length, 3, "slot must have exactly 3 fields");
    }
  }
});

// ── 11. API errors return typed availability error ────────────────────────────

test("API error returns ok:false with code cliniccard_availability_error", async () => {
  const result = await checkClinicCardAvailability(BASE_INPUT, makeErrorAdapter("HTTP 401: Unauthorized"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_availability_error");
    assert.match(result.error.message, /401/);
  }
});

// ── 12. Multi-day range ───────────────────────────────────────────────────────

test("date_to extends range across multiple days", async () => {
  const input: AvailabilityInput = { ...BASE_INPUT, date: "2026-07-01", date_to: "2026-07-02" };
  const result = await checkClinicCardAvailability(input, makeAdapter([]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.total_slots, 12); // 6 slots/day × 2 days
    const day1 = result.data.slots.filter((s) => s.date === "2026-07-01");
    const day2 = result.data.slots.filter((s) => s.date === "2026-07-02");
    assert.equal(day1.length, 6);
    assert.equal(day2.length, 6);
  }
});

// ── 13. Visits for different doctor/cabinet do not block slots ────────────────

test("visit for different doctor_id does not block slot", async () => {
  const visit = makeVisit({ doctor_id: 999, cabinet_id: 2, status: "PLANNED" });
  const result = await checkClinicCardAvailability(BASE_INPUT, makeAdapter([visit]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.free_slots_count, result.data.total_slots, "all slots must be free when visit is for different doctor");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { AvailabilityAdapter } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";

const VALID_ENV = {
  CLINICCARD_API_BASE_URL: "https://test.cliniccard.com",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_DEFAULT_DOCTOR_ID: "111431",
  CLINICCARD_DEFAULT_CABINET_ID: "43393",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_BOOKING_MODE: "disabled",
};

function makeAdapter(visits: ClinicCardVisit[]): AvailabilityAdapter {
  return { listVisits: async () => ({ ok: true, data: visits }) };
}

function makeErrorAdapter(message: string): AvailabilityAdapter {
  return { listVisits: async () => ({ ok: false, error: { code: "cliniccard_http_error", message } }) };
}

// ── 1. Missing requested_date ─────────────────────────────────────────────────

test("missing requested_date returns failed result", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({});
  assert.equal(result.tool, "availability.check");
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "availability_missing_requested_date");
    assert.equal(result.error.retryable, false);
  }
});

// ── 2. Missing CLINICCARD_API_BASE_URL ────────────────────────────────────────

test("missing CLINICCARD_API_BASE_URL returns failed result with config_missing_field", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...VALID_ENV, CLINICCARD_API_BASE_URL: undefined },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ requested_date: "2026-07-01" });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "cliniccard_config_missing_field");
  }
});

// ── 3. Missing CLINICCARD_API_TOKEN ───────────────────────────────────────────

test("missing CLINICCARD_API_TOKEN returns failed result with config_missing_field", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...VALID_ENV, CLINICCARD_API_TOKEN: undefined },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ requested_date: "2026-07-01" });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "cliniccard_config_missing_field");
  }
});

// ── 4. Invalid CLINICCARD_DEFAULT_DOCTOR_ID ───────────────────────────────────

test("non-integer CLINICCARD_DEFAULT_DOCTOR_ID returns failed result", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...VALID_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "abc" },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ requested_date: "2026-07-01" });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "cliniccard_config_invalid_doctor_id");
  }
});

// ── 5. Invalid CLINICCARD_DEFAULT_CABINET_ID ──────────────────────────────────

test("zero CLINICCARD_DEFAULT_CABINET_ID returns failed result", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...VALID_ENV, CLINICCARD_DEFAULT_CABINET_ID: "0" },
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ requested_date: "2026-07-01" });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "cliniccard_config_invalid_cabinet_id");
  }
});

// ── 6. Success: free slots mapped with starts_at/ends_at and counts ───────────

test("success result maps slots to starts_at/ends_at format and includes total_slots/free_slots_count", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ requested_date: "2026-07-01" });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.ok(result.data.total_slots > 0, "total_slots must be positive");
    assert.equal(result.data.free_slots_count, result.data.total_slots, "all slots free when no visits");
    assert.ok(result.data.slots.length > 0);
    const first = result.data.slots[0];
    assert.ok(typeof first.slot_id === "string" && first.slot_id.startsWith("2026-07-01"));
    assert.ok(typeof first.starts_at === "string" && first.starts_at.startsWith("2026-07-01T"));
    assert.ok(typeof first.ends_at === "string" && first.ends_at.startsWith("2026-07-01T"));
  }
});

// ── 7. API error → failed ─────────────────────────────────────────────────────

test("API error from adapter returns failed result", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeErrorAdapter("HTTP 401: Unauthorized"),
  });
  const result = await executor({ requested_date: "2026-07-01" });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.match(result.error.message, /401/);
    assert.equal(result.error.retryable, false);
  }
});

// ── 8. All slots booked → success with empty slots ────────────────────────────

test("all slots booked returns success with empty slots array and zero free_slots_count", async () => {
  const visits: ClinicCardVisit[] = [];
  for (let m = 9 * 60; m < 18 * 60; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const hh2 = String(Math.floor((m + 30) / 60)).padStart(2, "0");
    const mm2 = String((m + 30) % 60).padStart(2, "0");
    visits.push({
      id: m,
      patient_id: 1,
      doctor_id: 111431,
      cabinet_id: 43393,
      date: "2026-07-01",
      time_start: `${hh}:${mm}`,
      time_end: `${hh2}:${mm2}`,
      status: "PLANNED",
    });
  }
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeAdapter(visits),
  });
  const result = await executor({ requested_date: "2026-07-01" });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.data.slots.length, 0);
    assert.equal(result.data.free_slots_count, 0);
    assert.ok(result.data.total_slots > 0, "total_slots must reflect all generated slots");
  }
});

// ── 9. No write operations in source ──────────────────────────────────────────

test("executor source does not reference any write operations", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    resolve(dir, "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /createPatient/, "must not reference createPatient");
  assert.doesNotMatch(src, /createVisit/, "must not reference createVisit");
  assert.doesNotMatch(src, /booking\.apply/, "must not reference booking.apply");
  assert.doesNotMatch(src, /slot_hold/, "must not reference slot_hold");
  assert.doesNotMatch(src, /admin\.notify/, "must not reference admin.notify");
  assert.doesNotMatch(src, /handoff\.create/, "must not reference handoff.create");
});

// ── 10. doctor_id/cabinet_id from config only — never from context ────────────

test("executor reads doctor_id and cabinet_id from config, not from context", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    resolve(dir, "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts"),
    "utf8",
  );
  assert.match(src, /default_doctor_id/, "must reference default_doctor_id from config");
  assert.match(src, /default_cabinet_id/, "must reference default_cabinet_id from config");
  assert.doesNotMatch(src, /context\.doctor_id/, "must not read doctor_id from context");
  assert.doesNotMatch(src, /context\.cabinet_id/, "must not read cabinet_id from context");
});

// ── 11. requested_time HH:MM filters morning slots ───────────────────────────

test("requested_time=15:00 excludes slots before 15:00 from returned slots", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ requested_date: "2026-07-01", requested_time: "15:00" });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    for (const slot of result.data.slots) {
      assert.ok(
        slot.starts_at >= "2026-07-01T15:00",
        `slot ${slot.starts_at} must not be before 15:00`,
      );
    }
    assert.ok(result.data.slots.length > 0, "must have at least one slot at/after 15:00");
    // full-day counts are unaffected by time filter
    assert.ok(result.data.total_slots > result.data.slots.length, "total_slots reflects the full day");
  }
});

test("requested_time=natural-language string is ignored — all slots returned", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeAdapter([]),
  });
  const all = await executor({ requested_date: "2026-07-01" });
  const filtered = await executor({ requested_date: "2026-07-01", requested_time: "afternoon" });
  assert.equal(all.status, "success");
  assert.equal(filtered.status, "success");
  if (all.status === "success" && filtered.status === "success") {
    assert.equal(filtered.data.slots.length, all.data.slots.length, "natural-language time must not filter slots");
  }
});

// ── 12. limit caps returned slots; counts remain full-day ─────────────────────

test("limit=3 returns at most 3 slots while total_slots and free_slots_count reflect the full day", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeAdapter([]),
  });
  const result = await executor({ requested_date: "2026-07-01", limit: 3 });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.ok(result.data.slots.length <= 3, "slots must be capped to limit=3");
    assert.ok(result.data.total_slots > 3, "total_slots must reflect full day, not the limit");
    assert.ok(result.data.free_slots_count > 3, "free_slots_count must reflect full day, not the limit");
  }
});

test("limit=0 is ignored — all slots returned", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: VALID_ENV,
    adapterFactory: () => makeAdapter([]),
  });
  const all = await executor({ requested_date: "2026-07-01" });
  const limited = await executor({ requested_date: "2026-07-01", limit: 0 });
  assert.equal(all.status, "success");
  assert.equal(limited.status, "success");
  if (all.status === "success" && limited.status === "success") {
    assert.equal(limited.data.slots.length, all.data.slots.length, "limit=0 must not cap slots");
  }
});

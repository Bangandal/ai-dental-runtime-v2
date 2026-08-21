import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

import {
  getIsoWeekday,
  isDateInsideAvailabilityPolicy,
  loadClinicCardAvailabilityPolicy,
} from "../src/integrations/cliniccard/clinicCardAvailabilityPolicy.ts";
import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { AvailabilityAdapter } from "../src/integrations/cliniccard/clinicCardAvailability.ts";

const BASE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_DEFAULT_DOCTOR_ID: "7",
  CLINICCARD_DEFAULT_CABINET_ID: "3",
  CLINICCARD_TIMEZONE: "Europe/Prague",
};

const POLICY_ENV: Record<string, string> = {
  ...clinicCardServiceAuthorityEnv({ service_key: "availability", aliases: ["availability"], doctor_id: 7, cabinet_id: 3, duration_minutes: 60 }),
  ...BASE_ENV,
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5",
  CLINICCARD_WORKING_HOURS_START: "10:00",
  CLINICCARD_WORKING_HOURS_END: "12:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "60",
  CLINICCARD_CLOSED_DATES: "",
};

function emptyAdapter(onListVisits?: () => void): AvailabilityAdapter {
  return {
    async listVisits() {
      onListVisits?.();
      return { ok: true, data: [] };
    },
  };
}

test("PF-007a: availability policy fails closed until operator confirmation is explicit", () => {
  const result = loadClinicCardAvailabilityPolicy({ ...POLICY_ENV, CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "false" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cliniccard_availability_policy_missing");
    assert.match(result.error.message, /CONFIRMED=true/);
  }
});

test("PF-007a: availability policy has no silent working-hours or duration defaults", () => {
  for (const key of ["CLINICCARD_WORKING_DAYS", "CLINICCARD_WORKING_HOURS_START", "CLINICCARD_WORKING_HOURS_END", "CLINICCARD_SLOT_DURATION_MINUTES", "CLINICCARD_CLOSED_DATES"]) {
    const env: Record<string, string | undefined> = { ...POLICY_ENV };
    delete env[key];
    const result = loadClinicCardAvailabilityPolicy(env);
    assert.equal(result.ok, false, `${key} must be required`);
  }
});

test("PF-007a: invalid calendar dates are rejected rather than rolled into another day", () => {
  assert.equal(getIsoWeekday("2026-02-31"), null);
  const result = loadClinicCardAvailabilityPolicy({ ...POLICY_ENV, CLINICCARD_CLOSED_DATES: "2026-02-31" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "cliniccard_availability_policy_invalid");
});

test("PF-007a: configured weekday and closed-date policy is deterministic", () => {
  const result = loadClinicCardAvailabilityPolicy({ ...POLICY_ENV, CLINICCARD_CLOSED_DATES: "2026-08-24" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getIsoWeekday("2026-08-24"), 1);
  assert.equal(getIsoWeekday("2026-08-23"), 7);
  assert.equal(isDateInsideAvailabilityPolicy("2026-08-24", result.data), false);
  assert.equal(isDateInsideAvailabilityPolicy("2026-08-25", result.data), true);
  assert.equal(isDateInsideAvailabilityPolicy("2026-08-23", result.data), false);
});

test("PF-007a: availability executor fails before ClinicCard access when schedule policy is absent", async () => {
  let adapterCreated = false;
  const executor = createClinicCardAvailabilityExecutor({ env: BASE_ENV, adapterFactory: () => { adapterCreated = true; return emptyAdapter(); } });
  const result = await executor({ clinic_id: "clinic_1", service_interest: "availability", requested_date: "2026-08-24", requested_time: "10:00" });
  assert.equal(adapterCreated, false);
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.error.code, "cliniccard_availability_policy_missing");
});

test("PF-007a: non-working day is authoritative empty availability with zero ClinicCard reads", async () => {
  let adapterCreated = false;
  const executor = createClinicCardAvailabilityExecutor({ env: POLICY_ENV, adapterFactory: () => { adapterCreated = true; return emptyAdapter(); } });
  const result = await executor({ clinic_id: "clinic_1", service_interest: "availability", requested_date: "2026-08-23", requested_time: "10:00" });
  assert.equal(adapterCreated, false);
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.data.slots, []);
    assert.equal(result.data.total_slots, 0);
    assert.equal(result.data.free_slots_count, 0);
  }
});

test("PF-007a: explicitly closed date is authoritative empty availability with zero ClinicCard reads", async () => {
  let adapterCreated = false;
  const executor = createClinicCardAvailabilityExecutor({ env: { ...POLICY_ENV, CLINICCARD_CLOSED_DATES: "2026-08-24" }, adapterFactory: () => { adapterCreated = true; return emptyAdapter(); } });
  const result = await executor({ clinic_id: "clinic_1", service_interest: "availability", requested_date: "2026-08-24", requested_time: "10:00" });
  assert.equal(adapterCreated, false);
  assert.equal(result.status, "success");
  if (result.status === "success") assert.deepEqual(result.data.slots, []);
});

test("PF-007a: generated slots come only from explicit hours and duration", async () => {
  let listVisitsCalls = 0;
  const executor = createClinicCardAvailabilityExecutor({ env: POLICY_ENV, adapterFactory: () => emptyAdapter(() => { listVisitsCalls += 1; }) });
  const result = await executor({ clinic_id: "clinic_1", service_interest: "availability", requested_date: "2026-08-24", requested_time: "10:00" });
  assert.equal(listVisitsCalls, 1);
  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  assert.equal(result.data.total_slots, 2);
  assert.equal(result.data.free_slots_count, 2);
  assert.deepEqual(result.data.slots, [
    { slot_id: "2026-08-24T10:00", starts_at: "2026-08-24T10:00:00", ends_at: "2026-08-24T11:00:00" },
    { slot_id: "2026-08-24T11:00", starts_at: "2026-08-24T11:00:00", ends_at: "2026-08-24T12:00:00" },
  ]);
});

test("PF-007a: malformed requested_date fails before ClinicCard access", async () => {
  let adapterCreated = false;
  const executor = createClinicCardAvailabilityExecutor({ env: POLICY_ENV, adapterFactory: () => { adapterCreated = true; return emptyAdapter(); } });
  const result = await executor({ clinic_id: "clinic_1", service_interest: "availability", requested_date: "2026-02-31", requested_time: "10:00" });
  assert.equal(adapterCreated, false);
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.error.code, "availability_invalid_requested_date");
});

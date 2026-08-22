import assert from "node:assert/strict";
import test from "node:test";

import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import {
  resolveClinicCardServiceSchedule,
  validateClinicCardServiceSlot,
} from "../src/integrations/cliniccard/clinicCardServiceResourcePolicy.ts";
import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

function envWithProviderSchedule(params: {
  working_days: readonly number[];
  working_hours_start: string;
  working_hours_end: string;
  closed_dates?: readonly string[];
}): Record<string, string> {
  return {
    ...clinicCardServiceAuthorityEnv({
      service_key: "consultation",
      aliases: ["consultation"],
      doctor_id: 10,
      cabinet_id: 20,
      duration_minutes: 30,
      availability: params,
    }),
    CLINICCARD_API_BASE_URL: "https://cliniccard.invalid",
    CLINICCARD_API_TOKEN: "test-token",
    CLINICCARD_DEFAULT_DOCTOR_ID: "999",
    CLINICCARD_DEFAULT_CABINET_ID: "998",
    CLINICCARD_TIMEZONE: "Europe/Prague",
    CLINICCARD_BOOKING_MODE: "disabled",
    CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
    CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
    CLINICCARD_WORKING_HOURS_START: "09:00",
    CLINICCARD_WORKING_HOURS_END: "18:00",
    CLINICCARD_SLOT_DURATION_MINUTES: "30",
    CLINICCARD_CLOSED_DATES: "",
  };
}

test("PF-013: resource mapping without provider schedule is not availability authority", () => {
  const env = {
    CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "true",
    CLINICCARD_SERVICE_RESOURCE_RULES_JSON: JSON.stringify([{
      service_key: "consultation",
      aliases: ["consultation"],
      doctor_id: 10,
      cabinet_id: 20,
      duration_minutes: 30,
    }]),
  };

  const result = resolveClinicCardServiceSchedule(env, "consultation");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure, "schedule_unavailable");
});

test("PF-013: provider non-working date-only request auto-extends to the nearest provider working day", async () => {
  let listVisitsCount = 0;
  const executor = createClinicCardAvailabilityExecutor({
    env: envWithProviderSchedule({
      working_days: [1],
      working_hours_start: "10:00",
      working_hours_end: "12:00",
      closed_dates: [],
    }),
    adapterFactory: () => ({
      listVisits: async () => {
        listVisitsCount += 1;
        return { ok: true as const, data: [] };
      },
    }),
  });

  // 2099-08-22 is Saturday; the provider works Monday only.
  const result = await executor({
    requested_date: "2099-08-22",
    service_interest: "consultation",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.data.nearest_available_date, "2099-08-24");
    assert.equal(result.data.free_slots_count, 4);
    assert.deepEqual(
      result.data.slots.map((slot) => [slot.starts_at, slot.ends_at]),
      [
        ["2099-08-24T10:00:00", "2099-08-24T10:30:00"],
        ["2099-08-24T10:30:00", "2099-08-24T11:00:00"],
        ["2099-08-24T11:00:00", "2099-08-24T11:30:00"],
        ["2099-08-24T11:30:00", "2099-08-24T12:00:00"],
      ],
    );
  }
  assert.equal(listVisitsCount, 1);
});

test("PF-013: specific time on provider non-working day remains unavailable without auto-extension", async () => {
  let listVisitsCount = 0;
  const executor = createClinicCardAvailabilityExecutor({
    env: envWithProviderSchedule({
      working_days: [1],
      working_hours_start: "10:00",
      working_hours_end: "12:00",
      closed_dates: [],
    }),
    adapterFactory: () => ({
      listVisits: async () => {
        listVisitsCount += 1;
        return { ok: true as const, data: [] };
      },
    }),
  });

  const result = await executor({
    requested_date: "2099-08-22",
    requested_time: "10:00",
    service_interest: "consultation",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.data.slots, []);
    assert.equal(result.data.free_slots_count, 0);
    assert.equal(result.data.requested_time, "10:00");
    assert.equal(result.data.requested_time_available, false);
  }
  assert.equal(listVisitsCount, 0);
});

test("PF-013: generated availability is restricted to the provider working window", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: envWithProviderSchedule({
      working_days: [1],
      working_hours_start: "10:00",
      working_hours_end: "12:00",
      closed_dates: [],
    }),
    adapterFactory: () => ({
      listVisits: async () => ({ ok: true as const, data: [] }),
    }),
  });

  // 2099-08-24 is Monday.
  const result = await executor({
    requested_date: "2099-08-24",
    service_interest: "consultation",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(
      result.data.slots.map((slot) => [slot.starts_at, slot.ends_at]),
      [
        ["2099-08-24T10:00:00", "2099-08-24T10:30:00"],
        ["2099-08-24T10:30:00", "2099-08-24T11:00:00"],
        ["2099-08-24T11:00:00", "2099-08-24T11:30:00"],
        ["2099-08-24T11:30:00", "2099-08-24T12:00:00"],
      ],
    );
  }
});

test("PF-013: provider closed date-only request auto-extends to the next authorized working day", async () => {
  let listVisitsCount = 0;
  const executor = createClinicCardAvailabilityExecutor({
    env: envWithProviderSchedule({
      working_days: [1],
      working_hours_start: "10:00",
      working_hours_end: "12:00",
      closed_dates: ["2099-08-24"],
    }),
    adapterFactory: () => ({
      listVisits: async () => {
        listVisitsCount += 1;
        return { ok: true as const, data: [] };
      },
    }),
  });

  const result = await executor({
    requested_date: "2099-08-24",
    service_interest: "consultation",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.data.nearest_available_date, "2099-08-31");
    assert.equal(result.data.free_slots_count, 4);
    assert.deepEqual(
      result.data.slots.map((slot) => slot.starts_at),
      [
        "2099-08-31T10:00:00",
        "2099-08-31T10:30:00",
        "2099-08-31T11:00:00",
        "2099-08-31T11:30:00",
      ],
    );
  }
  assert.equal(listVisitsCount, 1);
});

test("PF-013: specific time on provider closed date remains unavailable without auto-extension", async () => {
  let listVisitsCount = 0;
  const executor = createClinicCardAvailabilityExecutor({
    env: envWithProviderSchedule({
      working_days: [1],
      working_hours_start: "10:00",
      working_hours_end: "12:00",
      closed_dates: ["2099-08-24"],
    }),
    adapterFactory: () => ({
      listVisits: async () => {
        listVisitsCount += 1;
        return { ok: true as const, data: [] };
      },
    }),
  });

  const result = await executor({
    requested_date: "2099-08-24",
    requested_time: "10:00",
    service_interest: "consultation",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.data.slots, []);
    assert.equal(result.data.free_slots_count, 0);
    assert.equal(result.data.requested_time, "10:00");
    assert.equal(result.data.requested_time_available, false);
  }
  assert.equal(listVisitsCount, 0);
});

test("PF-013: provider slot validation rejects slots outside provider hours", () => {
  const env = envWithProviderSchedule({
    working_days: [1],
    working_hours_start: "10:00",
    working_hours_end: "12:00",
    closed_dates: [],
  });
  const resolved = resolveClinicCardServiceSchedule(env, "consultation");
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.deepEqual(
    validateClinicCardServiceSlot("2099-08-24", "10:30", "11:00", resolved.schedule),
    { ok: true },
  );
  const rejected = validateClinicCardServiceSlot("2099-08-24", "09:30", "10:00", resolved.schedule);
  assert.equal(rejected.ok, false);
});

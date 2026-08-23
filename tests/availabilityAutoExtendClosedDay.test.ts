import assert from "node:assert/strict";
import test from "node:test";

import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { AvailabilityAdapter } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

function makeOpenAdapter(): AvailabilityAdapter {
  return { listVisits: async () => ({ ok: true, data: [] }) };
}

function buildEnv(params?: {
  clinicWorkingDays?: string;
  providerWorkingDays?: readonly number[];
}) {
  return {
    ...clinicCardServiceAuthorityEnv({
      service_key: "cleaning",
      aliases: ["cleaning"],
      doctor_id: 111431,
      cabinet_id: 43393,
      duration_minutes: 30,
      availability: {
        working_days: params?.providerWorkingDays ?? [1, 2, 3, 4, 5],
        working_hours_start: "09:00",
        working_hours_end: "18:00",
        closed_dates: [],
      },
    }),
    CLINICCARD_API_BASE_URL: "https://test.cliniccard.com",
    CLINICCARD_API_TOKEN: "test-token",
    CLINICCARD_TIMEZONE: "Europe/Prague",
    CLINICCARD_BOOKING_MODE: "disabled",
    CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
    CLINICCARD_WORKING_DAYS: params?.clinicWorkingDays ?? "1,2,3,4,5",
    CLINICCARD_WORKING_HOURS_START: "09:00",
    CLINICCARD_WORKING_HOURS_END: "18:00",
    CLINICCARD_SLOT_DURATION_MINUTES: "30",
    CLINICCARD_CLOSED_DATES: "",
  };
}

test("clinic-closed requested date auto-extends to the nearest working day with one range read", async () => {
  const reads: Array<{ from: string; to: string }> = [];
  const adapter: AvailabilityAdapter = {
    listVisits: async (from, to) => {
      reads.push({ from, to });
      return { ok: true, data: [] };
    },
  };
  const executor = createClinicCardAvailabilityExecutor({
    env: buildEnv(),
    adapterFactory: () => adapter,
  });

  // 2026-08-22 is Saturday; next clinic/provider working day is Monday 2026-08-24.
  const result = await executor({
    service_interest: "cleaning",
    requested_date: "2026-08-22",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.data.nearest_available_date, "2026-08-24");
    assert.ok(result.data.slots.length > 0);
    assert.ok(result.data.slots.every((slot) => slot.starts_at.startsWith("2026-08-24T")));
  }
  assert.deepEqual(reads, [{ from: "2026-08-23", to: "2026-08-29" }]);
});

test("provider non-working requested date auto-extends even when clinic is open", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: buildEnv({
      clinicWorkingDays: "1,2,3,4,5,6,7",
      providerWorkingDays: [1, 2, 3, 4, 5],
    }),
    adapterFactory: () => makeOpenAdapter(),
  });

  // 2026-08-23 is Sunday; clinic is open by global policy but provider is not.
  const result = await executor({
    service_interest: "cleaning",
    requested_date: "2026-08-23",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.data.nearest_available_date, "2026-08-24");
    assert.ok(result.data.slots.length > 0);
    assert.ok(result.data.slots.every((slot) => slot.starts_at.startsWith("2026-08-24T")));
  }
});

test("specific time on a closed day remains an authoritative unavailable result", async () => {
  let reads = 0;
  const adapter: AvailabilityAdapter = {
    listVisits: async () => {
      reads += 1;
      return { ok: true, data: [] };
    },
  };
  const executor = createClinicCardAvailabilityExecutor({
    env: buildEnv(),
    adapterFactory: () => adapter,
  });

  const result = await executor({
    service_interest: "cleaning",
    requested_date: "2026-08-22",
    requested_time: "12:00",
  });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.data.slots, []);
    assert.equal(result.data.requested_time, "12:00");
    assert.equal(result.data.requested_time_available, false);
    assert.equal(result.data.requested_time_status, "unavailable");
    assert.equal(result.data.nearest_available_date, undefined);
  }
  assert.equal(reads, 0, "closed-day time truth needs no ClinicCard read");
});

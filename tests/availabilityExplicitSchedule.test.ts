import assert from "node:assert/strict";
import test from "node:test";

import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { AvailabilityAdapter } from "../src/integrations/cliniccard/clinicCardAvailability.ts";

const BASE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_BOOKING_MODE: "disabled",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_HOLIDAYS: "",
};

function emptyAdapter(onList?: () => void): AvailabilityAdapter {
  return {
    listVisits: async () => {
      onList?.();
      return { ok: true, data: [] };
    },
  };
}

test("AV-TRUTH-1: missing explicit working days fails closed before ClinicCard read", async () => {
  const env: Record<string, string | undefined> = { ...BASE_ENV };
  delete env.CLINICCARD_WORKING_DAYS;
  let listCalled = false;
  const executor = createClinicCardAvailabilityExecutor({
    env,
    adapterFactory: () => emptyAdapter(() => { listCalled = true; }),
  });

  const result = await executor({ requested_date: "2026-07-20" });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "cliniccard_schedule_config_missing_field");
  }
  assert.equal(listCalled, false);
});

test("AV-TRUTH-2: Saturday is closed under Mon-Fri config and produces no synthetic slots", async () => {
  let listCalled = false;
  const executor = createClinicCardAvailabilityExecutor({
    env: BASE_ENV,
    adapterFactory: () => emptyAdapter(() => { listCalled = true; }),
  });

  const result = await executor({ requested_date: "2026-07-18" }); // Saturday
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.data.slots, []);
    assert.equal(result.data.total_slots, 0);
    assert.equal(result.data.free_slots_count, 0);
  }
  assert.equal(listCalled, false, "closed date must not need a visits read");
});

test("AV-TRUTH-3: configured holiday is closed even on a working weekday", async () => {
  let listCalled = false;
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_ENV, CLINICCARD_HOLIDAYS: "2026-07-20" },
    adapterFactory: () => emptyAdapter(() => { listCalled = true; }),
  });

  const result = await executor({ requested_date: "2026-07-20" }); // Monday
  assert.equal(result.status, "success");
  if (result.status === "success") assert.deepEqual(result.data.slots, []);
  assert.equal(listCalled, false);
});

test("AV-TRUTH-4: configured 12:00-17:00 interval is the slot-generation boundary", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: {
      ...BASE_ENV,
      CLINICCARD_WORKING_HOURS_START: "12:00",
      CLINICCARD_WORKING_HOURS_END: "17:00",
    },
    adapterFactory: () => emptyAdapter(),
  });

  const result = await executor({ requested_date: "2026-07-20" });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.data.slots[0]?.starts_at, "2026-07-20T12:00:00");
    assert.equal(result.data.slots.at(-1)?.ends_at, "2026-07-20T17:00:00");
    assert.equal(result.data.total_slots, 10);
  }
});

test("AV-TRUTH-5: configured 60-minute duration changes generated offers deterministically", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: { ...BASE_ENV, CLINICCARD_SLOT_DURATION_MINUTES: "60" },
    adapterFactory: () => emptyAdapter(),
  });

  const result = await executor({ requested_date: "2026-07-20" });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(result.data.total_slots, 9);
    assert.equal(result.data.slots[0]?.starts_at, "2026-07-20T09:00:00");
    assert.equal(result.data.slots[0]?.ends_at, "2026-07-20T10:00:00");
    assert.equal(result.data.slots.at(-1)?.ends_at, "2026-07-20T18:00:00");
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import type { AvailabilityAdapter } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

const ENV = {
  ...clinicCardServiceAuthorityEnv({ service_key: "availability", aliases: ["availability"], doctor_id: 111431, cabinet_id: 43393, duration_minutes: 30 }),

  CLINICCARD_API_BASE_URL: "https://test.cliniccard.com",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_DEFAULT_DOCTOR_ID: "111431",
  CLINICCARD_DEFAULT_CABINET_ID: "43393",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_BOOKING_MODE: "disabled",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_CLOSED_DATES: "",
};

type AvailabilityData = {
  slots: Array<{ slot_id: string; starts_at: string; ends_at: string }>;
  requested_time?: string;
  requested_time_available?: boolean;
  requested_time_status?: string;
};

function makeCountingAdapter(visits: ClinicCardVisit[]) {
  let reads = 0;
  const adapter: AvailabilityAdapter = {
    async listVisits() {
      reads += 1;
      return { ok: true as const, data: visits };
    },
  };
  return { adapter, getReads: () => reads };
}

test("PF-003: occupied 14:00 returns later alternatives from one ClinicCard read", async () => {
  const visit: ClinicCardVisit = {
    id: 1,
    patient_id: 10,
    doctor_id: 111431,
    cabinet_id: 43393,
    date: "2026-09-01",
    time_start: "14:00",
    time_end: "15:00",
    status: "PLANNED",
  };
  const counted = makeCountingAdapter([visit]);
  const executor = createClinicCardAvailabilityExecutor({
    env: ENV,
    adapterFactory: () => counted.adapter,
  });

  const result = await executor({ service_interest: "availability", requested_date: "2026-09-01", requested_time: "14:00", limit: 3 });
  assert.equal(result.status, "success");
  assert.equal(counted.getReads(), 1, "exact time plus alternatives must come from one ClinicCard read");

  if (result.status === "success") {
    const data = result.data as AvailabilityData;
    assert.equal(data.requested_time, "14:00");
    assert.equal(data.requested_time_available, false);
    assert.equal(data.requested_time_status, "unavailable");
    assert.deepEqual(
      data.slots.map((slot) => slot.starts_at),
      ["2026-09-01T15:00:00", "2026-09-01T15:30:00", "2026-09-01T16:00:00"],
    );
  }
});

test("PF-003: free 14:00 is explicit and appears first in the same anchored result", async () => {
  const counted = makeCountingAdapter([]);
  const executor = createClinicCardAvailabilityExecutor({
    env: ENV,
    adapterFactory: () => counted.adapter,
  });

  const result = await executor({ service_interest: "availability", requested_date: "2026-09-01", requested_time: "14:00", limit: 3 });
  assert.equal(result.status, "success");
  assert.equal(counted.getReads(), 1);

  if (result.status === "success") {
    const data = result.data as AvailabilityData;
    assert.equal(data.requested_time, "14:00");
    assert.equal(data.requested_time_available, true);
    assert.equal(data.requested_time_status, "available");
    assert.equal(data.slots[0]?.starts_at, "2026-09-01T14:00:00");
  }
});

test("PF-003: model tool contract tells the model to reuse returned nearby alternatives", () => {
  const description = RUNTIME_AGENT_TOOL_DEFINITIONS["availability.check"].description;
  assert.match(description, /requested_time_available/);
  assert.match(description, /requested_time once/);
  assert.match(description, /without another availability\.check/);
});

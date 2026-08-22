import assert from "node:assert/strict";
import test from "node:test";

import {
  createClinicCardAdapter,
  type ClinicCardFetch,
} from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";

const CONFIG: ClinicCardConfig = {
  api_base_url: "https://cliniccards.example",
  api_token: "tok_test",
  default_doctor_id: "111431",
  default_cabinet_id: "43393",
  timezone: "Europe/Prague",
  booking_mode: "live",
};

function okResponse(payload: unknown): Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
}

test("listVisits range derives each visit date from full visit_start when date field is absent", async () => {
  const fetch: ClinicCardFetch = async () => okResponse({
    result: "ok",
    error: null,
    data: [
      {
        visit_id: "789",
        visit_start: "2026-07-08 11:15:00",
        visit_end: "2026-07-08 11:45:00",
        doctor_id: "111431",
        cabinet_id: "43393",
        status: "PLANNED",
      },
      {
        visit_id: "790",
        visit_start: "2026-07-10T14:00:00",
        visit_end: "2026-07-10T14:30:00",
        doctor_id: "111431",
        cabinet_id: "43393",
        status: "CONFIRMED",
      },
    ],
  });

  const adapter = createClinicCardAdapter(CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-06", "2026-07-12");

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unexpected failure");
  assert.deepEqual(
    result.data.map((visit) => ({ id: visit.id, date: visit.date, time_start: visit.time_start })),
    [
      { id: 789, date: "2026-07-08", time_start: "11:15" },
      { id: 790, date: "2026-07-10", time_start: "14:00" },
    ],
  );
});

test("listVisits range fails closed when a time-only visit has no date field", async () => {
  const fetch: ClinicCardFetch = async () => okResponse({
    result: "ok",
    error: null,
    data: [
      {
        visit_id: "789",
        visit_start: "11:15",
        visit_end: "11:45",
        doctor_id: "111431",
        cabinet_id: "43393",
        status: "PLANNED",
      },
    ],
  });

  const adapter = createClinicCardAdapter(CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-06", "2026-07-12");

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected validation failure");
  assert.equal(result.error.code, "cliniccard_validation_error");
  assert.match(result.error.message, /missing date\/visit_date/);
});

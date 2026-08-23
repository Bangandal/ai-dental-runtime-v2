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

test("listVisits range falls back to bounded single-day reads for time-only visits", async () => {
  const reads: Array<{ from: string; to: string }> = [];
  const fetch: ClinicCardFetch = async (url) => {
    const parsed = new URL(url);
    const from = parsed.searchParams.get("from") ?? "";
    const to = parsed.searchParams.get("to") ?? "";
    reads.push({ from, to });

    if (from !== to) {
      return okResponse({
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
    }

    return okResponse({
      result: "ok",
      error: null,
      data: from === "2026-07-08"
        ? [
            {
              visit_id: "789",
              visit_start: "11:15",
              visit_end: "11:45",
              doctor_id: "111431",
              cabinet_id: "43393",
              status: "PLANNED",
            },
          ]
        : [],
    });
  };

  const adapter = createClinicCardAdapter(CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-06", "2026-07-12");

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unexpected failure");
  assert.deepEqual(
    result.data.map((visit) => ({ id: visit.id, date: visit.date, time_start: visit.time_start })),
    [{ id: 789, date: "2026-07-08", time_start: "11:15" }],
  );
  assert.equal(reads.length, 8, "one range read plus seven bounded day reads");
  assert.deepEqual(reads[0], { from: "2026-07-06", to: "2026-07-12" });
  assert.deepEqual(
    reads.slice(1).map((read) => read.from),
    [
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ],
  );
});

test("listVisits does not expand a wider ambiguous range into unbounded fallback reads", async () => {
  let reads = 0;
  const fetch: ClinicCardFetch = async () => {
    reads += 1;
    return okResponse({
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
  };

  const adapter = createClinicCardAdapter(CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-01", "2026-07-12");

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected validation failure");
  assert.equal(result.error.code, "cliniccard_validation_error");
  assert.match(result.error.message, /missing date\/visit_date/);
  assert.equal(reads, 1, "wider ambiguous range must stay fail-closed");
});

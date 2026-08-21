import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";
import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

const ENV: Record<string, string> = {
  ...clinicCardServiceAuthorityEnv({
    service_key: "consultation",
    aliases: ["consultation"],
    doctor_id: 10,
    cabinet_id: 20,
    duration_minutes: 30,
  }),
  CLINICCARD_API_BASE_URL: "https://cliniccard.invalid",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "999",
  CLINICCARD_DEFAULT_CABINET_ID: "998",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "15",
  CLINICCARD_CLOSED_DATES: "",
};

function bookingContext() {
  return {
    clinic_id: "clinic_1",
    first_name: "Anna",
    last_name: "Koval",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button" as const,
    phone_belongs_to_patient: true,
    requested_date: "2099-08-21",
    requested_time: "10:00",
    service_interest: "consultation",
  };
}

function asRuntimeToolResult(data: Record<string, unknown>): RuntimeAgentToolResult {
  return {
    tool: "booking.apply",
    call_id: "pf012-call",
    status: "success",
    data,
  };
}

test("PF-012 GOLDEN: availability timeout is retryable but never becomes an availability claim", async () => {
  const executor = createClinicCardAvailabilityExecutor({
    env: ENV,
    adapterFactory: () => ({
      listVisits: async () => ({
        ok: false as const,
        error: { code: "cliniccard_timeout", message: "ClinicCard read timed out" },
      }),
    }),
  });

  const result = await executor({
    requested_date: "2099-08-21",
    service_interest: "consultation",
  });

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "cliniccard_timeout");
    assert.equal(result.error.retryable, true);
  }
});

test("PF-012 GOLDEN: timed-out visit write is outcome-unknown and cannot be claimed booked", async () => {
  const adapter: ClinicCardAdapter = {
    findPatientByPhone: async () => ({
      ok: true,
      data: [{ id: 33, name: "Anna Koval", phone: "+420111222333" }],
    }),
    createPatient: async (input) => ({
      ok: true,
      data: { id: 44, name: input.name, phone: input.phone ?? null },
    }),
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => ({
      ok: false,
      error: { code: "cliniccard_timeout", message: "ClinicCard visit write timed out" },
    }),
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const executor = createBookingApplyExecutor({ env: ENV, adapterFactory: () => adapter });
  const result = await executor(bookingContext());

  assert.equal(result.status, "success");
  assert.equal(result.data.booking_status, "booking_outcome_unknown");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.equal(result.data.cliniccard_visit_id, null);

  const truth = buildBookingApplyActionTruth([
    asRuntimeToolResult(result.data as unknown as Record<string, unknown>),
  ]);
  assert.ok(truth);
  assert.equal(truth.allowed_claims.can_say_booking_created, false);
  assert.equal(truth.allowed_claims.can_say_booking_confirmed, false);
  assert.equal(truth.required_next_action, "admin_handoff");
});

test("PF-012 GOLDEN: timed-out patient creation is outcome-unknown and stops before createVisit", async () => {
  let createVisitCount = 0;
  const adapter: ClinicCardAdapter = {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async () => ({
      ok: false,
      error: { code: "cliniccard_timeout", message: "ClinicCard patient write timed out" },
    }),
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => {
      createVisitCount += 1;
      throw new Error("createVisit must not run after unknown patient write outcome");
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const executor = createBookingApplyExecutor({ env: ENV, adapterFactory: () => adapter });
  const result = await executor(bookingContext());

  assert.equal(result.data.booking_status, "booking_outcome_unknown");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.equal(createVisitCount, 0);
});

test("PF-012 GOLDEN: definite visit write failure remains cliniccard_write_failed", async () => {
  const adapter: ClinicCardAdapter = {
    findPatientByPhone: async () => ({
      ok: true,
      data: [{ id: 33, name: "Anna Koval", phone: "+420111222333" }],
    }),
    createPatient: async (input) => ({
      ok: true,
      data: { id: 44, name: input.name, phone: input.phone ?? null },
    }),
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => ({
      ok: false,
      error: { code: "visit_write_failed", message: "definite write rejection" },
    }),
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const executor = createBookingApplyExecutor({ env: ENV, adapterFactory: () => adapter });
  const result = await executor(bookingContext());

  assert.equal(result.data.booking_status, "cliniccard_write_failed");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.equal(result.data.cliniccard_visit_id, null);
});

test("PF-012 GOLDEN: retry after lost createVisit response does not create a duplicate visit", async () => {
  const visits: ClinicCardVisit[] = [];
  let createVisitCount = 0;

  const adapter: ClinicCardAdapter = {
    findPatientByPhone: async () => ({
      ok: true,
      data: [{ id: 33, name: "Anna Koval", phone: "+420111222333" }],
    }),
    createPatient: async (input) => ({
      ok: true,
      data: { id: 44, name: input.name, phone: input.phone ?? null },
    }),
    listVisits: async () => ({ ok: true, data: visits }),
    createVisit: async (input) => {
      createVisitCount += 1;
      const created: ClinicCardVisit = {
        id: 700,
        patient_id: input.patient_id,
        doctor_id: input.doctor_id,
        cabinet_id: input.cabinet_id,
        date: input.date,
        time_start: input.time_start,
        time_end: input.time_end,
        status: input.status,
        note: input.note ?? null,
      };
      visits.push(created);
      return {
        ok: false,
        error: { code: "cliniccard_timeout", message: "response lost after server commit" },
      };
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const executor = createBookingApplyExecutor({ env: ENV, adapterFactory: () => adapter });
  const first = await executor(bookingContext());
  assert.equal(first.data.booking_status, "booking_outcome_unknown");
  assert.equal(createVisitCount, 1);
  assert.equal(visits.length, 1, "the first request reached ClinicCard despite the lost response");

  const second = await executor(bookingContext());
  assert.equal(second.data.booking_status, "slot_conflict");
  assert.equal(second.data.created_visit, false);
  assert.equal(second.data.may_claim_booked, false);
  assert.equal(createVisitCount, 1, "fresh re-read must stop a duplicate createVisit POST");
  assert.equal(visits.length, 1);
});

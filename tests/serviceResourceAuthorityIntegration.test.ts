import assert from "node:assert/strict";
import test from "node:test";

import { createClinicCardAvailabilityExecutor } from "../src/integrations/cliniccard/clinicCardAvailabilityExecutor.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardCreateVisitInput, ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";

const ENV: Record<string, string> = {
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
  CLINICCARD_SERVICE_RESOURCE_POLICY_CONFIRMED: "true",
  CLINICCARD_SERVICE_RESOURCE_RULES_JSON: JSON.stringify([
    {
      service_key: "cleaning",
      aliases: ["чистка", "Чистка зубов"],
      doctor_id: 11,
      cabinet_id: 21,
      duration_minutes: 30,
    },
    {
      service_key: "orthodontics",
      aliases: ["ортодонт", "брекеты"],
      doctor_id: 12,
      cabinet_id: 22,
      duration_minutes: 60,
    },
  ]),
};

function makeAdapter(params: {
  visits?: ClinicCardVisit[];
  createdVisits?: ClinicCardCreateVisitInput[];
  onCall?: () => void;
} = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => {
      params.onCall?.();
      return { ok: true, data: [{ id: 33, name: "Anna Koval", phone: "+420111222333" }] };
    },
    createPatient: async (input) => {
      params.onCall?.();
      return { ok: true, data: { id: 44, name: input.name, phone: input.phone ?? null } };
    },
    listVisits: async () => {
      params.onCall?.();
      return { ok: true, data: params.visits ?? [] };
    },
    createVisit: async (input) => {
      params.onCall?.();
      params.createdVisits?.push(input);
      return {
        ok: true,
        data: {
          id: 700 + (params.createdVisits?.length ?? 0),
          patient_id: input.patient_id,
          doctor_id: input.doctor_id,
          cabinet_id: input.cabinet_id,
          date: input.date,
          time_start: input.time_start,
          time_end: input.time_end,
          status: input.status,
          note: input.note ?? null,
        },
      };
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };
}

test("PF-011 GOLDEN: service determines availability provider/resource/duration", async () => {
  const visits: ClinicCardVisit[] = [{
    id: 1,
    patient_id: 100,
    doctor_id: 11,
    cabinet_id: 21,
    date: "2099-08-21",
    time_start: "09:00",
    time_end: "09:30",
    status: "PLANNED",
  }];
  const adapter = makeAdapter({ visits });
  const executor = createClinicCardAvailabilityExecutor({ env: ENV, adapterFactory: () => adapter });

  const cleaning = await executor({
    requested_date: "2099-08-21",
    service_interest: "чистка",
  });
  const orthodontics = await executor({
    requested_date: "2099-08-21",
    service_interest: "брекеты",
  });

  assert.equal(cleaning.status, "success");
  assert.equal(orthodontics.status, "success");
  if (cleaning.status === "success" && orthodontics.status === "success") {
    assert.equal(cleaning.data.slots.some((slot) => slot.starts_at === "2099-08-21T09:00:00"), false,
      "cleaning slot conflicts on doctor 11 / cabinet 21");
    assert.equal(orthodontics.data.slots[0]?.starts_at, "2099-08-21T09:00:00",
      "orthodontics uses a different resource, so 09:00 remains free");
    assert.equal(cleaning.data.slots[0]?.ends_at.slice(11, 16), "10:00",
      "first free cleaning slot is 09:30-10:00");
    assert.equal(orthodontics.data.slots[0]?.ends_at.slice(11, 16), "10:00",
      "orthodontics 09:00 slot lasts 60 minutes");
    assert.equal(orthodontics.data.slots[1]?.starts_at, "2099-08-21T09:15:00",
      "60-minute service still follows the confirmed 15-minute start grid");
    assert.equal(orthodontics.data.slots[1]?.ends_at, "2099-08-21T10:15:00",
      "service duration controls occupancy independently of start cadence");
  }
});

test("PF-011 GOLDEN: booking independently resolves the same service resources", async () => {
  const createdVisits: ClinicCardCreateVisitInput[] = [];
  const adapter = makeAdapter({ createdVisits });
  const executor = createBookingApplyExecutor({ env: ENV, adapterFactory: () => adapter });

  const cleaning = await executor({
    clinic_id: "clinic_1",
    first_name: "Anna",
    last_name: "Koval",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    phone_belongs_to_patient: true,
    requested_date: "2099-08-21",
    requested_time: "10:00",
    service_interest: "Чистка зубов",
  });
  const orthodontics = await executor({
    clinic_id: "clinic_1",
    first_name: "Anna",
    last_name: "Koval",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    phone_belongs_to_patient: true,
    requested_date: "2099-08-21",
    requested_time: "11:15",
    service_interest: "ортодонт",
  });

  assert.equal(cleaning.status, "success");
  assert.equal(orthodontics.status, "success");
  assert.equal(cleaning.data.booking_status, "visit_created");
  assert.equal(orthodontics.data.booking_status, "visit_created");
  assert.equal(createdVisits.length, 2);
  assert.deepEqual(
    {
      doctor_id: createdVisits[0]?.doctor_id,
      cabinet_id: createdVisits[0]?.cabinet_id,
      time_start: createdVisits[0]?.time_start,
      time_end: createdVisits[0]?.time_end,
    },
    { doctor_id: 11, cabinet_id: 21, time_start: "10:00", time_end: "10:30" },
  );
  assert.deepEqual(
    {
      doctor_id: createdVisits[1]?.doctor_id,
      cabinet_id: createdVisits[1]?.cabinet_id,
      time_start: createdVisits[1]?.time_start,
      time_end: createdVisits[1]?.time_end,
    },
    { doctor_id: 12, cabinet_id: 22, time_start: "11:15", time_end: "12:15" },
  );
});

test("PF-011 GOLDEN: missing or unmapped service fails before ClinicCard access", async () => {
  let calls = 0;
  const adapter = makeAdapter({ onCall: () => { calls += 1; } });
  const availability = createClinicCardAvailabilityExecutor({ env: ENV, adapterFactory: () => adapter });
  const booking = createBookingApplyExecutor({ env: ENV, adapterFactory: () => adapter });

  const missing = await availability({ requested_date: "2099-08-21" });
  assert.equal(missing.status, "failed");
  if (missing.status === "failed") assert.equal(missing.error.code, "availability_service_required");

  const unmapped = await booking({
    clinic_id: "clinic_1",
    first_name: "Anna",
    last_name: "Koval",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    requested_date: "2099-08-21",
    requested_time: "10:00",
    service_interest: "имплантация",
  });
  assert.equal(unmapped.status, "success");
  assert.equal(unmapped.data.booking_status, "config_missing");
  assert.equal(unmapped.data.created_visit, false);
  assert.equal(calls, 0, "service authority must fail before any ClinicCard read or write");
});

test("PF-011 GOLDEN: legacy global defaults cannot override confirmed service rules", async () => {
  const createdVisits: ClinicCardCreateVisitInput[] = [];
  const adapter = makeAdapter({ createdVisits });
  const executor = createBookingApplyExecutor({
    env: {
      ...ENV,
      CLINICCARD_DEFAULT_DOCTOR_ID: "999999",
      CLINICCARD_DEFAULT_CABINET_ID: "888888",
      CLINICCARD_SLOT_DURATION_MINUTES: "5",
    },
    adapterFactory: () => adapter,
  });

  const result = await executor({
    clinic_id: "clinic_1",
    first_name: "Anna",
    last_name: "Koval",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    phone_belongs_to_patient: true,
    requested_date: "2099-08-21",
    requested_time: "10:00",
    service_interest: "чистка",
  });

  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(createdVisits[0]?.doctor_id, 11);
  assert.equal(createdVisits[0]?.cabinet_id, 21);
  assert.equal(createdVisits[0]?.time_end, "10:30");
});

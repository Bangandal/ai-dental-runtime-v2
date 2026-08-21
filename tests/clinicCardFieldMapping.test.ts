import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import { createClinicCardAdapter, type ClinicCardFetch } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const TEST_CONFIG: ClinicCardConfig = {
  api_base_url: "https://cliniccards.example",
  api_token: "tok_test",
  default_doctor_id: "111431",
  default_cabinet_id: "43393",
  timezone: "Europe/Prague",
  booking_mode: "live",
};
const CLINIC_UUID = "e8179559-fc8d-40e5-9808-287ed69fcf7c";
const TEST_PHONE = "PHONE_TEST";

function okResponse(payload: unknown): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
  return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
}

test("ClinicCard adapter maps real patient fields", async () => {
  const fetch: ClinicCardFetch = async () => okResponse({ result: "ok", error: null, data: [{ patient_id: "123", firstname: "Vasya", lastname: "Demidov", phone: TEST_PHONE }] });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.findPatientByPhone(TEST_PHONE);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unexpected failure");
  assert.deepEqual(result.data, [{ id: 123, name: "Vasya Demidov", phone: TEST_PHONE, email: null, birth_date: null, created_at: null }]);
});

test("ClinicCard adapter sends firstname/lastname and maps patient_id on createPatient", async () => {
  const seenBodies: unknown[] = [];
  const fetch: ClinicCardFetch = async (_url, init) => {
    seenBodies.push(JSON.parse(init.body ?? "{}"));
    return okResponse({ result: "ok", error: null, data: { patient_id: 456, firstname: "Vasya", lastname: "Demidov", phone: TEST_PHONE } });
  };
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createPatient({ name: "Vasya Demidov", phone: TEST_PHONE });
  assert.deepEqual(seenBodies[0], { firstname: "Vasya", lastname: "Demidov", phone: TEST_PHONE });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unexpected failure");
  assert.equal(result.data.id, 456);
});

test("ClinicCard adapter maps real visit fields without inventing patient id", async () => {
  const fetch: ClinicCardFetch = async () => okResponse({ result: "ok", error: null, data: [{ visit_id: "789", visit_start: "11:15", visit_end: "17:15", doctor_id: "111431", cabinet_id: "43393", status: "PLANNED" }] });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-06", "2026-07-06");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unexpected failure");
  assert.equal(result.data[0]?.id, 789);
  assert.equal(result.data[0]?.patient_id, null);
  assert.equal(result.data[0]?.date, "2026-07-06");
  assert.equal(result.data[0]?.time_start, "11:15");
  assert.equal(result.data[0]?.time_end, "17:15");
  assert.equal(result.data[0]?.doctor_id, 111431);
  assert.equal(result.data[0]?.cabinet_id, 43393);
});

test("booking.apply detects conflict from real ClinicCard visit shape without patient id", async () => {
  const fetch: ClinicCardFetch = async () => okResponse({ result: "ok", error: null, data: [{ visit_id: 789, visit_start: "11:15", visit_end: "17:15", doctor_id: "111431", cabinet_id: "43393", status: "PLANNED" }] });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const executor = createBookingApplyExecutor({
    env: {
      ...clinicCardServiceAuthorityEnv({ service_key: "cleaning", aliases: ["cleaning"], doctor_id: 111431, cabinet_id: 43393, duration_minutes: 30 }),
      CLINICCARD_API_BASE_URL: TEST_CONFIG.api_base_url,
      CLINICCARD_API_TOKEN: TEST_CONFIG.api_token,
      CLINICCARD_BOOKING_MODE: "live",
      CLINICCARD_DEFAULT_DOCTOR_ID: "111431",
      CLINICCARD_DEFAULT_CABINET_ID: "43393",
      CLINICCARD_TIMEZONE: "Europe/Prague",
      CLINICCARD_LIVE_CLINIC_ALLOWLIST: CLINIC_UUID,
      CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
      CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
      CLINICCARD_WORKING_HOURS_START: "00:00",
      CLINICCARD_WORKING_HOURS_END: "23:59",
      CLINICCARD_SLOT_DURATION_MINUTES: "30",
      CLINICCARD_CLOSED_DATES: "",
    },
    adapterFactory: () => adapter,
  });
  const context: ToolExecutionContext = {
    clinic_id: CLINIC_UUID,
    contact_id: "contact_1",
    case_id: "case_1",
    first_name: "Vasya",
    last_name: "Demidov",
    service_interest: "cleaning",
    requested_date: "2026-07-06",
    requested_time: "16:00",
    phone_number: TEST_PHONE,
    phone_source: "telegram_contact_button",
  };
  const result = await executor(context);
  assert.equal(result.status, "success");
  assert.equal(result.data.booking_status, "slot_conflict");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

test("ClinicCard adapter sends time_start/time_end (HH:MM) in write request and maps visit_id from response", async () => {
  const seenBodies: unknown[] = [];
  const fetch: ClinicCardFetch = async (_url, init) => {
    seenBodies.push(JSON.parse(init.body ?? "{}"));
    return okResponse({ result: "ok", error: null, data: { visit_id: "999", patient_id: "456", date: "2026-07-06", visit_start: "2026-07-06 16:00:00", visit_end: "2026-07-06 16:30:00", doctor_id: "111431", cabinet_id: "43393", status: "PLANNED" } });
  };
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.createVisit({ patient_id: 456, doctor_id: 111431, cabinet_id: 43393, date: "2026-07-06", time_start: "16:00", time_end: "16:30", status: "PLANNED", note: "cleaning" });
  assert.deepEqual(seenBodies[0], { patient_id: 456, doctor_id: 111431, cabinet_id: 43393, date: "2026-07-06", time_start: "16:00", time_end: "16:30", status: "PLANNED", note: "cleaning" });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unexpected failure");
  assert.equal(result.data.id, 999);
  assert.equal(result.data.patient_id, 456);
  assert.equal(result.data.time_start, "16:00");
  assert.equal(result.data.time_end, "16:30");
});

test("listVisits normalizes full datetime visit_start/visit_end to HH:MM", async () => {
  const fetch: ClinicCardFetch = async () => okResponse({ result: "ok", error: null, data: [{ visit_id: "58555719", patient_id: "16166348", visit_start: "2026-07-06 11:15:00", visit_end: "2026-07-06 17:15:00", doctor_id: "111431", cabinet_id: "43393", status: "PLANNED" }] });
  const adapter = createClinicCardAdapter(TEST_CONFIG, fetch);
  const result = await adapter.listVisits("2026-07-06", "2026-07-06");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unexpected failure");
  assert.equal(result.data[0]?.id, 58555719);
  assert.equal(result.data[0]?.time_start, "11:15");
  assert.equal(result.data[0]?.time_end, "17:15");
  assert.equal(result.data[0]?.patient_id, 16166348);
});

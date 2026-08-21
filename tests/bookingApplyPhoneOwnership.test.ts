import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { PatientIdentityAuthority, ResolvePatientIdentityInput } from "../src/runtime/patientIdentityAuthority.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const LIVE_ENV: Record<string, string> = {
  ...clinicCardServiceAuthorityEnv({ service_key: "consultation", aliases: ["Consultation"], doctor_id: 1, cabinet_id: 2, duration_minutes: 30 }),

  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "tok_test",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "00:00",
  CLINICCARD_WORKING_HOURS_END: "23:59",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_CLOSED_DATES: "",
};

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    first_name: "Anna",
    last_name: "Koval",
    service_interest: "Consultation",
    requested_date: "2026-08-25",
    requested_time: "10:00",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    ...overrides,
  };
}

function makeAdapter(): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async (input) => ({
      ok: true,
      data: { id: 42, name: input.name, phone: input.phone ?? null },
    }),
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async (input) => ({
      ok: true,
      data: {
        id: 99,
        patient_id: input.patient_id,
        doctor_id: input.doctor_id,
        cabinet_id: input.cabinet_id,
        date: input.date,
        time_start: input.time_start,
        time_end: input.time_end,
        status: input.status,
        note: input.note ?? null,
      },
    }),
    listPayments: async () => ({ ok: true, data: [] }),
  };
}

function capturingAuthority(calls: ResolvePatientIdentityInput[]): PatientIdentityAuthority {
  return {
    async resolve(input) {
      calls.push(input);
      return { ok: true, resolution: "create_patient_required" };
    },
  };
}

test("R1b-OWN-1: booking executor forwards explicit phone_belongs_to_patient=false", async () => {
  const calls: ResolvePatientIdentityInput[] = [];
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
    patientIdentityAuthorityFactory: () => capturingAuthority(calls),
  });

  const result = await executor(makeContext({
    phone_belongs_to_patient: false,
    contact_phone_owner_subject_id: undefined,
  }));

  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone_belongs_to_patient, false);
  assert.equal("contact_role" in calls[0], false);
});

test("R1b-OWN-2: explicit ownership fact wins over legacy subject provenance", async () => {
  const calls: ResolvePatientIdentityInput[] = [];
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
    patientIdentityAuthorityFactory: () => capturingAuthority(calls),
  });

  const result = await executor(makeContext({
    phone_belongs_to_patient: true,
    contact_phone_owner_subject_id: "subject_1",
  }));

  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone_belongs_to_patient, true);
});

test("R1b-OWN-3: legacy subject provenance remains a temporary compatibility fallback", async () => {
  const calls: ResolvePatientIdentityInput[] = [];
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
    patientIdentityAuthorityFactory: () => capturingAuthority(calls),
  });

  const result = await executor(makeContext({
    phone_belongs_to_patient: undefined,
    contact_phone_owner_subject_id: "subject_1",
  }));

  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone_belongs_to_patient, false);
});

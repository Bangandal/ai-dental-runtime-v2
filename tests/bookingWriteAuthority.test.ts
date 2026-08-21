import assert from "node:assert/strict";
import test from "node:test";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import { createClinicCardBookingWriteAuthority } from "../src/integrations/cliniccard/clinicCardBookingWriteAuthority.ts";
import type {
  ClinicCardCreatePatientInput,
  ClinicCardCreateVisitInput,
} from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { BookingWriteInput } from "../src/runtime/bookingWriteAuthority.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const LIVE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.invalid",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "10",
  CLINICCARD_DEFAULT_CABINET_ID: "20",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "00:00",
  CLINICCARD_WORKING_HOURS_END: "23:59",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_CLOSED_DATES: "",
};

function visit(patientId: number) {
  return {
    id: 700,
    patient_id: patientId,
    doctor_id: 10,
    cabinet_id: 20,
    date: "2099-08-21",
    time_start: "10:00",
    time_end: "10:30",
    status: "PLANNED" as const,
    note: "consultation",
  };
}

function baseWriteInput(patient: BookingWriteInput["patient"]): BookingWriteInput {
  return {
    patient,
    visit: {
      doctor_id: 10,
      cabinet_id: 20,
      date: "2099-08-21",
      time_start: "10:00",
      time_end: "10:30",
      status: "PLANNED",
      note: "consultation",
    },
  };
}

function adapterForWrites(params: {
  onCreatePatient?: (input: ClinicCardCreatePatientInput) => void;
  onCreateVisit?: (input: ClinicCardCreateVisitInput) => void;
  patientFailure?: string | null;
  visitFailure?: string | null;
} = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async (input) => {
      params.onCreatePatient?.(input);
      if (params.patientFailure) {
        return { ok: false, error: { code: "patient_write_failed", message: params.patientFailure } };
      }
      return { ok: true, data: { id: 55, name: input.name, phone: input.phone ?? null } };
    },
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async (input) => {
      params.onCreateVisit?.(input);
      if (params.visitFailure) {
        return { ok: false, error: { code: "visit_write_failed", message: params.visitFailure } };
      }
      return { ok: true, data: visit(input.patient_id) };
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };
}

test("R1-WRITE-1: existing patient skips patient creation and writes exactly one visit", async () => {
  let createPatientCount = 0;
  const visits: ClinicCardCreateVisitInput[] = [];
  const authority = createClinicCardBookingWriteAuthority(adapterForWrites({
    onCreatePatient: () => { createPatientCount += 1; },
    onCreateVisit: (input) => visits.push(input),
  }));

  const result = await authority.write(baseWriteInput({
    kind: "existing_patient",
    patient_id: 33,
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.patient_id, 33);
  assert.equal(createPatientCount, 0);
  assert.equal(visits.length, 1);
  assert.equal(visits[0]?.patient_id, 33);
});

test("R1-WRITE-2: create-required patient is created before the visit", async () => {
  const order: string[] = [];
  const authority = createClinicCardBookingWriteAuthority(adapterForWrites({
    onCreatePatient: () => order.push("createPatient"),
    onCreateVisit: () => order.push("createVisit"),
  }));

  const result = await authority.write(baseWriteInput({
    kind: "create_patient",
    name: "Anna Koval",
    phone_number: "+420111222333",
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(order, ["createPatient", "createVisit"]);
  assert.equal(result.patient_id, 55);
  assert.equal(result.visit.patient_id, 55);
});

test("R1-WRITE-3: patient creation failure stops before visit write", async () => {
  let createVisitCount = 0;
  const authority = createClinicCardBookingWriteAuthority(adapterForWrites({
    patientFailure: "patient timeout",
    onCreateVisit: () => { createVisitCount += 1; },
  }));

  const result = await authority.write(baseWriteInput({
    kind: "create_patient",
    name: "Anna Koval",
    phone_number: "+420111222333",
  }));

  assert.deepEqual(result, {
    ok: false,
    failure: "patient_write_failed",
    reason: "patient timeout",
  });
  assert.equal(createVisitCount, 0);
});

test("R1-WRITE-4: visit failure reports the resolved patient id for recovery diagnostics", async () => {
  const authority = createClinicCardBookingWriteAuthority(adapterForWrites({
    visitFailure: "visit timeout",
  }));

  const result = await authority.write(baseWriteInput({
    kind: "create_patient",
    name: "Anna Koval",
    phone_number: "+420111222333",
  }));

  assert.deepEqual(result, {
    ok: false,
    failure: "visit_write_failed",
    reason: "visit timeout",
    patient_id: 55,
  });
});

function bookingContext(): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    first_name: "Anna",
    last_name: "Koval",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    phone_belongs_to_patient: true,
    requested_date: "2099-08-21",
    requested_time: "10:00",
    service_interest: "consultation",
  };
}

test("R1-WRITE-5: bookingApplyExecutor cannot bypass BookingWriteAuthority", async () => {
  const writeCalls: BookingWriteInput[] = [];
  const adapter: ClinicCardAdapter = {
    findPatientByPhone: async () => {
      throw new Error("identity lookup must be owned by injected PatientIdentityAuthority in this test");
    },
    createPatient: async () => {
      throw new Error("bookingApplyExecutor must not call adapter.createPatient directly");
    },
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => {
      throw new Error("bookingApplyExecutor must not call adapter.createVisit directly");
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
    patientIdentityAuthorityFactory: () => ({
      resolve: async () => ({ ok: true, resolution: "create_patient_required" }),
    }),
    bookingWriteAuthorityFactory: () => ({
      write: async (input) => {
        writeCalls.push(input);
        return { ok: true, patient_id: 55, visit: visit(55) };
      },
    }),
  });

  const result = await executor(bookingContext());

  assert.equal(writeCalls.length, 1);
  assert.deepEqual(writeCalls[0]?.patient, {
    kind: "create_patient",
    name: "Anna Koval",
    phone_number: "+420111222333",
  });
  assert.equal(result.tool, "booking.apply");
  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(result.data.cliniccard_patient_id, 55);
  assert.equal(result.data.cliniccard_visit_id, "700");
});

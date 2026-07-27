import assert from "node:assert/strict";
import test from "node:test";
import { createAppointmentLookupExecutor } from "../src/integrations/cliniccard/appointmentLookupExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig, ClinicCardPatient, ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const LIVE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "tok_test",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
};

const NOW = new Date("2026-07-27T10:00:00Z");

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    phone_number: "+420777123456",
    phone_source: "telegram_contact_button",
    now: NOW,
    ...overrides,
  };
}

const PATIENT: ClinicCardPatient = {
  id: 42,
  name: "Ivan Petrov",
  phone: "+420777123456",
};

const FUTURE_VISIT: ClinicCardVisit = {
  id: 99,
  patient_id: 42,
  doctor_id: 1,
  cabinet_id: 2,
  date: "2026-08-15",
  time_start: "10:00",
  time_end: "10:30",
  status: "PLANNED",
  note: null,
};

function makeAdapter(overrides: Partial<ClinicCardAdapter> = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => ({ ok: true, data: [PATIENT] }),
    createPatient: async () => ({ ok: true, data: PATIENT }),
    listVisits: async () => ({ ok: true, data: [FUTURE_VISIT] }),
    createVisit: async () => ({
      ok: true,
      data: { id: 1, patient_id: 42, doctor_id: 1, cabinet_id: 2, date: "2026-08-15", time_start: "10:00", time_end: "10:30", status: "PLANNED", note: null },
    }),
    listPayments: async () => ({ ok: true, data: [] }),
    ...overrides,
  };
}

// LOOK-1: clinic not in allowlist → clinic_not_allowed
test("LOOK-1: clinic_id not in CLINICCARD_LIVE_CLINIC_ALLOWLIST returns clinic_not_allowed", async () => {
  const executor = createAppointmentLookupExecutor({
    env: { ...LIVE_ENV, CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_other" },
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "clinic_not_allowed");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-2: missing clinic_id → clinic_not_allowed
test("LOOK-2: missing clinic_id returns clinic_not_allowed", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({ clinic_id: undefined }));
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "clinic_not_allowed");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-3: no phone → identity_not_verified
test("LOOK-3: no phone returns identity_not_verified", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({ phone_number: undefined, phone_source: undefined }));
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "identity_not_verified");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-4: typed phone → identity_not_verified (stricter than booking.apply)
test("LOOK-4: typed phone source denied — identity_not_verified", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({ phone_source: "typed" }));
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "identity_not_verified");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-5: manual_input phone → identity_not_verified
test("LOOK-5: manual_input phone source denied — identity_not_verified", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({ phone_source: "manual_input" }));
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "identity_not_verified");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-6: patient not found → not_found with empty visits
test("LOOK-6: findPatientByPhone returns empty array → not_found", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ findPatientByPhone: async () => ({ ok: true, data: [] }) }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "not_found");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-7: multiple patients → multiple_patients
test("LOOK-7: findPatientByPhone returns multiple patients → multiple_patients", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({
      findPatientByPhone: async () => ({
        ok: true,
        data: [PATIENT, { ...PATIENT, id: 43, name: "Ivan Petrov II" }],
      }),
    }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "multiple_patients");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-8: patient found, no visits → no_upcoming_visits
test("LOOK-8: patient found but no upcoming PLANNED/CONFIRMED visits → no_upcoming_visits", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [] }) }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "no_upcoming_visits");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-9: found one PLANNED visit → found with visit details
test("LOOK-9: found one PLANNED visit → found with privacy-safe visit object", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "found");
  assert.equal(result.data.visits.length, 1);
  const v = result.data.visits[0];
  assert.equal(v.visit_id, "99");
  assert.equal(v.date, "2026-08-15");
  assert.equal(v.time_start, "10:00");
  assert.equal(v.time_end, "10:30");
  assert.equal(v.status, "PLANNED");
  // Privacy: no patient_id, doctor_id, cabinet_id, note
  assert.ok(!("patient_id" in v));
  assert.ok(!("doctor_id" in v));
  assert.ok(!("cabinet_id" in v));
  assert.ok(!("note" in v));
});

// LOOK-10: CONFIRMED visit is actionable too
test("LOOK-10: CONFIRMED visit is actionable — included in results", async () => {
  const confirmedVisit: ClinicCardVisit = { ...FUTURE_VISIT, id: 100, status: "CONFIRMED" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [confirmedVisit] }) }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "found");
  assert.equal(result.data.visits[0].status, "CONFIRMED");
});

// LOOK-11: VISITED status is NOT actionable — excluded
test("LOOK-11: VISITED status is not actionable — excluded from results", async () => {
  const visitedVisit: ClinicCardVisit = { ...FUTURE_VISIT, status: "VISITED" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [visitedVisit] }) }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "no_upcoming_visits");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-12: UNKNOWN status is NOT actionable — excluded
test("LOOK-12: UNKNOWN status is not actionable — excluded from results", async () => {
  const unknownVisit: ClinicCardVisit = { ...FUTURE_VISIT, status: "UNKNOWN" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [unknownVisit] }) }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "no_upcoming_visits");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-13: visits from other patients are excluded
test("LOOK-13: visits belonging to other patient_id are excluded", async () => {
  const otherPatientVisit: ClinicCardVisit = { ...FUTURE_VISIT, patient_id: 999 };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [otherPatientVisit] }) }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "no_upcoming_visits");
  assert.deepEqual(result.data.visits, []);
});

// LOOK-14: visits are sorted by date and time ascending
test("LOOK-14: multiple visits are sorted by date then time ascending", async () => {
  const v1: ClinicCardVisit = { ...FUTURE_VISIT, id: 1, date: "2026-09-01", time_start: "14:00", time_end: "14:30" };
  const v2: ClinicCardVisit = { ...FUTURE_VISIT, id: 2, date: "2026-08-15", time_start: "10:00", time_end: "10:30" };
  const v3: ClinicCardVisit = { ...FUTURE_VISIT, id: 3, date: "2026-08-15", time_start: "09:00", time_end: "09:30" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [v1, v2, v3] }) }),
  });
  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.lookup_status, "found");
  assert.equal(result.data.visits.length, 3);
  assert.equal(result.data.visits[0].visit_id, "3"); // 2026-08-15 09:00
  assert.equal(result.data.visits[1].visit_id, "2"); // 2026-08-15 10:00
  assert.equal(result.data.visits[2].visit_id, "1"); // 2026-09-01 14:00
});

// LOOK-15: whatsapp_sender and existing_cliniccard_patient are trusted
test("LOOK-15: whatsapp_sender and existing_cliniccard_patient are trusted identity sources", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });

  const whatsappResult = await executor(makeContext({ phone_source: "whatsapp_sender" }));
  assert.equal(whatsappResult.status, "success");
  assert.equal(whatsappResult.data.lookup_status, "found");

  const clinicCardResult = await executor(makeContext({ phone_source: "existing_cliniccard_patient" }));
  assert.equal(clinicCardResult.status, "success");
  assert.equal(clinicCardResult.data.lookup_status, "found");
});

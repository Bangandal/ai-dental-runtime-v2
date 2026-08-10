import assert from "node:assert/strict";
import test from "node:test";
import { createAppointmentLookupExecutor } from "../src/integrations/cliniccard/appointmentLookupExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig, ClinicCardPatient, ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { ToolExecutionContext, LookupBookingSubjectsView } from "../src/runtime/toolExecutor.ts";
import type { AppointmentLookupSuccessResult } from "../src/runtime/toolResults.ts";

const LIVE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "tok_test",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
};

// 2026-07-27T10:00:00Z = 12:00 CEST (UTC+2) in Prague
const NOW = new Date("2026-07-27T10:00:00Z");

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    phone_number: "+420777123456",
    phone_source: "telegram_contact_button",
    lookup_subject_id: "subject_1",
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

function asLookup(result: unknown): AppointmentLookupSuccessResult {
  const r = result as AppointmentLookupSuccessResult;
  assert.equal(r.status, "success");
  return r;
}

// ── LOOK-1..15: Clinic gate, identity gate, patient resolution, filtering ──

// LOOK-1: clinic not in allowlist → clinic_not_allowed
test("LOOK-1: clinic_id not in CLINICCARD_LIVE_CLINIC_ALLOWLIST returns clinic_not_allowed", async () => {
  const executor = createAppointmentLookupExecutor({
    env: { ...LIVE_ENV, CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_other" },
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "clinic_not_allowed");
  assert.deepEqual(r.data.appointments, []);
  assert.equal(r.data.may_claim_found, false);
});

// LOOK-2: missing clinic_id → clinic_not_allowed
test("LOOK-2: missing clinic_id returns clinic_not_allowed", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({ clinic_id: undefined })));
  assert.equal(r.data.lookup_status, "clinic_not_allowed");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-3: no phone → identity_not_verified
test("LOOK-3: no phone returns identity_not_verified", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({ phone_number: undefined, phone_source: undefined })));
  assert.equal(r.data.lookup_status, "identity_not_verified");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-4: typed phone → identity_not_verified (stricter than booking.apply)
test("LOOK-4: typed phone source denied — identity_not_verified", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({ phone_source: "typed" })));
  assert.equal(r.data.lookup_status, "identity_not_verified");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-5: manual_input phone → identity_not_verified
test("LOOK-5: manual_input phone source denied — identity_not_verified", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({ phone_source: "manual_input" })));
  assert.equal(r.data.lookup_status, "identity_not_verified");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-6: patient not found → patient_not_found with empty appointments
test("LOOK-6: findPatientByPhone returns empty array → patient_not_found", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ findPatientByPhone: async () => ({ ok: true, data: [] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "patient_not_found");
  assert.deepEqual(r.data.appointments, []);
  assert.equal(r.data.may_claim_found, false);
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
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "multiple_patients");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-8: patient found, no visits → no_upcoming_appointments
test("LOOK-8: patient found but no upcoming PLANNED/CONFIRMED visits → no_upcoming_appointments", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "no_upcoming_appointments");
  assert.deepEqual(r.data.appointments, []);
  assert.equal(r.data.may_claim_found, false);
});

// LOOK-9: found one PLANNED visit → single_match with privacy-safe visit object
test("LOOK-9: found one PLANNED visit → single_match with cliniccard_visit_id, no PII", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "single_match");
  assert.equal(r.data.appointments.length, 1);
  const v = r.data.appointments[0];
  assert.equal(v.cliniccard_visit_id, "99");
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
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "single_match");
  assert.equal(r.data.appointments[0].status, "CONFIRMED");
});

// LOOK-11: VISITED status is NOT actionable — excluded
test("LOOK-11: VISITED status is not actionable — excluded from results", async () => {
  const visitedVisit: ClinicCardVisit = { ...FUTURE_VISIT, status: "VISITED" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [visitedVisit] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "no_upcoming_appointments");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-12: UNKNOWN status is NOT actionable — excluded
test("LOOK-12: UNKNOWN status is not actionable — excluded from results", async () => {
  const unknownVisit: ClinicCardVisit = { ...FUTURE_VISIT, status: "UNKNOWN" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [unknownVisit] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "no_upcoming_appointments");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-13: visits from other patients are excluded
test("LOOK-13: visits belonging to other patient_id are excluded", async () => {
  const otherPatientVisit: ClinicCardVisit = { ...FUTURE_VISIT, patient_id: 999 };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [otherPatientVisit] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "no_upcoming_appointments");
  assert.deepEqual(r.data.appointments, []);
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
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "multiple_matches");
  assert.equal(r.data.appointments.length, 3);
  assert.equal(r.data.appointments[0].cliniccard_visit_id, "3"); // 2026-08-15 09:00
  assert.equal(r.data.appointments[1].cliniccard_visit_id, "2"); // 2026-08-15 10:00
  assert.equal(r.data.appointments[2].cliniccard_visit_id, "1"); // 2026-09-01 14:00
});

// LOOK-15: whatsapp_sender and existing_cliniccard_patient are trusted
test("LOOK-15: whatsapp_sender and existing_cliniccard_patient are trusted identity sources", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });

  const whatsappResult = asLookup(await executor(makeContext({ phone_source: "whatsapp_sender" })));
  assert.equal(whatsappResult.data.lookup_status, "single_match");

  const clinicCardResult = asLookup(await executor(makeContext({ phone_source: "existing_cliniccard_patient" })));
  assert.equal(clinicCardResult.data.lookup_status, "single_match");
});

// ── LOOK-16..34: Regression tests for FIX-LOOK spec ──

// LOOK-16: missing subject_id → subject_resolution_conflict
test("LOOK-16: missing subject_id returns subject_resolution_conflict", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({ lookup_subject_id: undefined })));
  assert.equal(r.data.lookup_status, "subject_resolution_conflict");
  assert.equal(r.data.required_next_action, "clarify_subject");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-17: invalid subject_id "subject_5" → subject_resolution_conflict
test("LOOK-17: subject_id outside subject_1..4 range returns subject_resolution_conflict", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({ lookup_subject_id: "subject_5" })));
  assert.equal(r.data.lookup_status, "subject_resolution_conflict");
  assert.equal(r.data.required_next_action, "clarify_subject");
});

// LOOK-18: subject_id "subject_2" with no registry → subject_resolution_conflict
test("LOOK-18: subject_id subject_2 without booking_subjects registry returns subject_resolution_conflict", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({
    lookup_subject_id: "subject_2",
    lookup_booking_subjects: undefined,
  })));
  assert.equal(r.data.lookup_status, "subject_resolution_conflict");
});

// LOOK-19: subject_id "subject_3" registry exists but subject_3 missing → subject_resolution_conflict
test("LOOK-19: subject_id subject_3 not present in registry returns subject_resolution_conflict", async () => {
  const partialRegistry: LookupBookingSubjectsView = {
    subjects: [
      { id: "subject_1", booking_contact: { phone_number: "+420777123456", source: "telegram_contact_button" } },
      { id: "subject_2", booking_contact: { phone_number: "+420777654321", source: "telegram_contact_button" } },
    ],
  };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({
    lookup_subject_id: "subject_3",
    lookup_booking_subjects: partialRegistry,
  })));
  assert.equal(r.data.lookup_status, "subject_resolution_conflict");
});

// LOOK-20: subject_2 phone source is "shared_from_subject" → identity_not_verified
// (must NOT borrow subject_1's phone via shared_from_subject reference)
test("LOOK-20: subject_2 with shared_from_subject source returns identity_not_verified, not borrowing subject_1 phone", async () => {
  const registryWithShared: LookupBookingSubjectsView = {
    subjects: [
      { id: "subject_1", booking_contact: { phone_number: "+420777123456", source: "telegram_contact_button" } },
      { id: "subject_2", booking_contact: { phone_number: "+420777123456", source: "shared_from_subject", owner_subject_id: "subject_1" } },
    ],
  };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext({
    lookup_subject_id: "subject_2",
    lookup_booking_subjects: registryWithShared,
  })));
  assert.equal(r.data.lookup_status, "identity_not_verified");
  assert.equal(r.data.required_next_action, "ask_for_trusted_contact");
});

// LOOK-21: subject_2 with their own telegram_contact_button → proceeds to lookup
test("LOOK-21: subject_2 with trusted telegram_contact_button source proceeds to appointment lookup", async () => {
  const registryOk: LookupBookingSubjectsView = {
    subjects: [
      { id: "subject_1", booking_contact: { phone_number: "+420777123456", source: "telegram_contact_button" } },
      { id: "subject_2", booking_contact: { phone_number: "+420777654321", source: "telegram_contact_button" } },
    ],
  };
  const subject2Patient: ClinicCardPatient = { id: 55, name: "Maria Kovalenko", phone: "+420777654321" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({
      findPatientByPhone: async () => ({ ok: true, data: [subject2Patient] }),
    }),
  });
  const r = asLookup(await executor(makeContext({
    lookup_subject_id: "subject_2",
    lookup_booking_subjects: registryOk,
    phone_number: "+420777123456",
    phone_source: "telegram_contact_button",
  })));
  // Must NOT return identity_not_verified — subject_2 has its own trusted contact
  assert.notEqual(r.data.lookup_status, "identity_not_verified");
  assert.notEqual(r.data.lookup_status, "subject_resolution_conflict");
});

// LOOK-22: date_from bad format → failed result
test("LOOK-22: date_from with wrong format returns failed status", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({ lookup_date_from: "27-07-2026" }));
  assert.equal(result.status, "failed");
  assert.ok((result as { error?: { code: string } }).error?.code === "invalid_date_range");
});

// LOOK-23: date_from impossible calendar date → failed result
test("LOOK-23: date_from Feb 30 (impossible date) returns failed status", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({ lookup_date_from: "2026-02-30" }));
  assert.equal(result.status, "failed");
  assert.ok((result as { error?: { code: string } }).error?.code === "invalid_date_range");
});

// LOOK-24: date_to before date_from → failed result
test("LOOK-24: date_to before date_from returns failed status", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({
    lookup_date_from: "2026-08-01",
    lookup_date_to: "2026-07-01",
  }));
  assert.equal(result.status, "failed");
  assert.ok((result as { error?: { code: string } }).error?.code === "invalid_date_range");
});

// LOOK-25: date range > 365 days → failed result
test("LOOK-25: date range exceeding 365 days returns failed status", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const result = await executor(makeContext({
    lookup_date_from: "2026-01-01",
    lookup_date_to: "2027-01-02", // 366 days
  }));
  assert.equal(result.status, "failed");
  assert.ok((result as { error?: { code: string } }).error?.code === "invalid_date_range");
});

// LOOK-26: default searched_range uses clinic-local today (not UTC midnight)
// NOW = 2026-07-27T10:00:00Z = 2026-07-27T12:00:00 Prague (CEST)
// → date_from should be "2026-07-27", date_to = "2027-01-23" (180 days later)
test("LOOK-26: default searched_range is clinic-local today, not UTC midnight", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.searched_range.date_from, "2026-07-27");
  assert.equal(r.data.searched_range.date_to, "2027-01-23");
});

// LOOK-27: same-day visit already past (time_start < current clinic-local time) → excluded
// NOW = 2026-07-27T10:00:00Z = 12:00 Prague; time_start "11:00" is before 12:00
test("LOOK-27: same-day visit with time_start before current clinic-local time is excluded", async () => {
  const pastTodayVisit: ClinicCardVisit = {
    ...FUTURE_VISIT,
    date: "2026-07-27",
    time_start: "11:00",
    time_end: "11:30",
  };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [pastTodayVisit] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "no_upcoming_appointments");
  assert.deepEqual(r.data.appointments, []);
});

// LOOK-28: same-day visit in the future (time_start > current clinic-local time) → included
// NOW = 2026-07-27T10:00:00Z = 12:00 Prague; time_start "14:00" is after 12:00
test("LOOK-28: same-day visit with time_start after current clinic-local time is included", async () => {
  const futureTodayVisit: ClinicCardVisit = {
    ...FUTURE_VISIT,
    date: "2026-07-27",
    time_start: "14:00",
    time_end: "14:30",
  };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [futureTodayVisit] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "single_match");
  assert.equal(r.data.appointments.length, 1);
  assert.equal(r.data.appointments[0].date, "2026-07-27");
});

// LOOK-29: may_claim_found is false when patient_not_found
test("LOOK-29: may_claim_found is false when patient_not_found", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ findPatientByPhone: async () => ({ ok: true, data: [] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "patient_not_found");
  assert.equal(r.data.may_claim_found, false);
});

// LOOK-30: may_claim_found is true, required_next_action is "none" for single_match
test("LOOK-30: single_match has may_claim_found=true and required_next_action=none", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "single_match");
  assert.equal(r.data.may_claim_found, true);
  assert.equal(r.data.required_next_action, "none");
});

// LOOK-31: multiple_matches has may_claim_found=true, required_next_action=ask_which_appointment
test("LOOK-31: multiple_matches has may_claim_found=true and required_next_action=ask_which_appointment", async () => {
  const v1: ClinicCardVisit = { ...FUTURE_VISIT, id: 1, date: "2026-08-15" };
  const v2: ClinicCardVisit = { ...FUTURE_VISIT, id: 2, date: "2026-09-01" };
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [v1, v2] }) }),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "multiple_matches");
  assert.equal(r.data.may_claim_found, true);
  assert.equal(r.data.required_next_action, "ask_which_appointment");
});

// LOOK-32: explicit date args appear in searched_range
test("LOOK-32: explicit date_from and date_to are echoed back in searched_range", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ listVisits: async () => ({ ok: true, data: [] }) }),
  });
  const r = asLookup(await executor(makeContext({
    lookup_date_from: "2026-09-01",
    lookup_date_to: "2026-12-31",
  })));
  assert.equal(r.data.searched_range.date_from, "2026-09-01");
  assert.equal(r.data.searched_range.date_to, "2026-12-31");
});

// LOOK-33: config_missing when required env vars absent
test("LOOK-33: missing CLINICCARD_API_BASE_URL returns config_missing", async () => {
  const noConfigEnv: Record<string, string> = {
    CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
    CLINICCARD_TIMEZONE: "Europe/Prague",
  };
  const executor = createAppointmentLookupExecutor({
    env: noConfigEnv,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "config_missing");
  assert.deepEqual(r.data.appointments, []);
  assert.equal(r.data.may_claim_found, false);
});

// LOOK-34: appointment object exposes cliniccard_visit_id (not visit_id) and no PII
test("LOOK-34: appointment object uses cliniccard_visit_id field and contains no PII fields", async () => {
  const executor = createAppointmentLookupExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asLookup(await executor(makeContext()));
  assert.equal(r.data.lookup_status, "single_match");
  const appt = r.data.appointments[0];
  // Must have cliniccard_visit_id
  assert.ok("cliniccard_visit_id" in appt, "cliniccard_visit_id must be present");
  // Must NOT have old field name
  assert.ok(!("visit_id" in appt), "visit_id must not be present");
  // No PII fields
  assert.ok(!("patient_id" in appt), "patient_id must not be exposed");
  assert.ok(!("doctor_id" in appt), "doctor_id must not be exposed");
  assert.ok(!("note" in appt), "note must not be exposed");
});

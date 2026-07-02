import assert from "node:assert/strict";
import test from "node:test";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";
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

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    first_name: "Ivan",
    last_name: "Petrov",
    service_interest: "Чистка зубов",
    requested_date: "2026-07-15",
    requested_time: "10:00",
    phone_number: "+420777123456",
    phone_source: "telegram_contact_button",
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<ClinicCardAdapter> = {}): ClinicCardAdapter {
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
        patient_id: 42,
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
    ...overrides,
  };
}

// booking_write_disabled — mode is disabled.
test("booking.apply: returns booking_write_disabled when mode is disabled", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "disabled" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.status, "success");
  assert.equal(result.data.booking_status, "booking_write_disabled");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.equal(result.data.cliniccard_visit_id, null);
  assert.equal(result.data.booking_action, "booking_apply");
  assert.match(result.data.reason, /disabled/);
});

// booking_write_disabled — shadow mode also blocked.
test("booking.apply: shadow mode also returns booking_write_disabled", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "shadow" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "booking_write_disabled");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// no write when mode != live — adapter must never be called.
test("booking.apply: no ClinicCard write calls occur when mode is not live", async () => {
  let writeCalled = false;
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "disabled" },
    adapterFactory: () =>
      makeAdapter({
        createPatient: async () => { writeCalled = true; return { ok: true, data: { id: 1, name: "x" } }; },
        createVisit: async () => { writeCalled = true; return { ok: false, error: { code: "e", message: "e" } }; },
      }),
  });

  await executor(makeContext());
  assert.equal(writeCalled, false, "no write call should have been made");
});

// booking_write_disabled — clinic_id not in CLINICCARD_LIVE_CLINIC_ALLOWLIST.
test("booking.apply: returns booking_write_disabled when clinic_id is not allowlisted", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_9" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "booking_write_disabled");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.match(result.data.reason, /not in CLINICCARD_LIVE_CLINIC_ALLOWLIST/);
});

// booking_write_disabled — allowlist unset entirely (fail closed).
test("booking.apply: returns booking_write_disabled when CLINICCARD_LIVE_CLINIC_ALLOWLIST is unset", async () => {
  const env = { ...LIVE_ENV };
  delete (env as Record<string, string | undefined>).CLINICCARD_LIVE_CLINIC_ALLOWLIST;
  const executor = createBookingApplyExecutor({
    env,
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "booking_write_disabled");
  assert.equal(result.data.may_claim_booked, false);
});

// booking_write_disabled — clinic_id missing from context entirely.
test("booking.apply: returns booking_write_disabled when clinic_id is missing from context", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext({ clinic_id: undefined }));
  assert.equal(result.data.booking_status, "booking_write_disabled");
  assert.match(result.data.reason, /clinic_id is missing/);
});

// Allowlist parses comma-separated values with surrounding whitespace.
test("booking.apply: allowlist accepts clinic_id among multiple comma-separated entries with whitespace", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_LIVE_CLINIC_ALLOWLIST: " clinic_0 , clinic_1 , clinic_2 " },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "visit_created");
});

// No ClinicCard reads/writes occur when clinic is not allowlisted.
test("booking.apply: no ClinicCard calls occur when clinic_id is not allowlisted", async () => {
  let called = false;
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_9" },
    adapterFactory: () =>
      makeAdapter({
        listVisits: async () => { called = true; return { ok: true, data: [] }; },
      }),
  });

  await executor(makeContext());
  assert.equal(called, false, "no ClinicCard call should have been made");
});

// missing_phone — phone_source is manual_input (unverified, not trusted for live writes).
test("booking.apply: returns missing_phone when phone_source is manual_input", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext({ phone_source: "manual_input" }));
  assert.equal(result.data.booking_status, "missing_phone");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.match(result.data.reason, /not a trusted contact proof/);
});

// missing_phone — phone_source absent even though phone_number is present.
test("booking.apply: returns missing_phone when phone_source is absent", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext({ phone_source: undefined }));
  assert.equal(result.data.booking_status, "missing_phone");
  assert.match(result.data.reason, /not a trusted contact proof/);
});

// visit_created — whatsapp_sender and existing_cliniccard_patient are trusted phone sources.
test("booking.apply: whatsapp_sender and existing_cliniccard_patient phone sources are trusted", async () => {
  for (const source of ["whatsapp_sender", "existing_cliniccard_patient"] as const) {
    const executor = createBookingApplyExecutor({
      env: LIVE_ENV,
      adapterFactory: () => makeAdapter(),
    });
    const result = await executor(makeContext({ phone_source: source }));
    assert.equal(result.data.booking_status, "visit_created", `phone_source=${source} should be trusted`);
  }
});

// missing_phone — channel_contact not set.
test("booking.apply: returns missing_phone when phone_number is absent", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext({ phone_number: undefined }));
  assert.equal(result.data.booking_status, "missing_phone");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// config_missing — doctor_id not set.
test("booking.apply: returns config_missing when CLINICCARD_DEFAULT_DOCTOR_ID is absent", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "config_missing");
  assert.match(result.data.reason, /DOCTOR_ID/);
});

// config_missing — cabinet_id not set.
test("booking.apply: returns config_missing when CLINICCARD_DEFAULT_CABINET_ID is zero", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_CABINET_ID: "0" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "config_missing");
  assert.match(result.data.reason, /CABINET_ID/);
});

// slot_conflict — overlapping visit for same doctor.
test("booking.apply: returns slot_conflict when doctor slot is taken", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        listVisits: async () => ({
          ok: true,
          data: [
            {
              id: 7,
              patient_id: 5,
              doctor_id: 1,
              cabinet_id: 9,
              date: "2026-07-15",
              time_start: "09:45",
              time_end: "10:15",
              status: "PLANNED",
            },
          ],
        }),
      }),
  });

  // Slot 10:00–10:30 overlaps with 09:45–10:15 for doctor_id=1.
  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "slot_conflict");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// slot_conflict — overlapping visit for same cabinet.
test("booking.apply: returns slot_conflict when cabinet is taken by a different doctor", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        listVisits: async () => ({
          ok: true,
          data: [
            {
              id: 8,
              patient_id: 5,
              doctor_id: 99,
              cabinet_id: 2,
              date: "2026-07-15",
              time_start: "10:00",
              time_end: "10:30",
              status: "PLANNED",
            },
          ],
        }),
      }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "slot_conflict");
});

// No conflict when visit is for a completely different doctor AND cabinet.
test("booking.apply: no conflict when visit is for a different doctor and cabinet", async () => {
  let visitCreated = false;
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        listVisits: async () => ({
          ok: true,
          data: [
            {
              id: 8,
              patient_id: 5,
              doctor_id: 99,
              cabinet_id: 88,
              date: "2026-07-15",
              time_start: "10:00",
              time_end: "10:30",
              status: "PLANNED",
            },
          ],
        }),
        createVisit: async (input) => {
          visitCreated = true;
          return {
            ok: true,
            data: {
              id: 100,
              patient_id: 42,
              doctor_id: input.doctor_id,
              cabinet_id: input.cabinet_id,
              date: input.date,
              time_start: input.time_start,
              time_end: input.time_end,
              status: input.status,
            },
          };
        },
      }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(visitCreated, true);
});

// visit_created — full happy path with proof.
test("booking.apply: returns visit_created with proof and correct fields on success", async () => {
  let patientInput: unknown;
  let visitInput: unknown;

  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        createPatient: async (input) => {
          patientInput = input;
          return { ok: true, data: { id: 42, name: input.name, phone: input.phone ?? null } };
        },
        createVisit: async (input) => {
          visitInput = input;
          return {
            ok: true,
            data: {
              id: 99,
              patient_id: 42,
              doctor_id: input.doctor_id,
              cabinet_id: input.cabinet_id,
              date: input.date,
              time_start: input.time_start,
              time_end: input.time_end,
              status: input.status,
            },
          };
        },
      }),
  });

  const result = await executor(makeContext());

  assert.equal(result.status, "success");
  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(result.data.created_visit, true);
  assert.equal(result.data.may_claim_booked, true);
  assert.equal(result.data.cliniccard_visit_id, "99");   // string, not number
  assert.equal(result.data.cliniccard_patient_id, 42);
  assert.equal(result.data.date, "2026-07-15");
  assert.equal(result.data.time_start, "10:00");
  assert.equal(result.data.time_end, "10:30");
  assert.equal(result.data.doctor_id, 1);
  assert.equal(result.data.cabinet_id, 2);
  assert.equal(result.data.timezone, "Europe/Prague");
  assert.ok(result.data.proof !== null);
  assert.equal((result.data.proof as Record<string, unknown>).cliniccard_visit_id, "99");

  const p = patientInput as { name: string; phone: string };
  assert.equal(p.name, "Ivan Petrov");
  assert.equal(p.phone, "+420777123456");

  const v = visitInput as { patient_id: number; doctor_id: number; cabinet_id: number; status: string; note?: string };
  assert.equal(v.patient_id, 42);
  assert.equal(v.doctor_id, 1);
  assert.equal(v.cabinet_id, 2);
  assert.equal(v.status, "PLANNED");
  assert.equal(v.note, "Чистка зубов");
});

// may_claim_booked is false on every non-visit_created status.
test("booking.apply: may_claim_booked is false for all non-success paths", async () => {
  const cases: Array<{ label: string; context: Partial<ToolExecutionContext>; env?: Record<string, string> }> = [
    { label: "booking_write_disabled", env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "disabled" }, context: {} },
    { label: "missing_phone", context: { phone_number: undefined } },
    { label: "config_missing", env: { ...LIVE_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "" }, context: {} },
  ];

  for (const c of cases) {
    const executor = createBookingApplyExecutor({
      env: c.env ?? LIVE_ENV,
      adapterFactory: () => makeAdapter(),
    });
    const result = await executor(makeContext(c.context));
    assert.equal(result.data.may_claim_booked, false, `${c.label} must have may_claim_booked=false`);
    assert.equal(result.data.created_visit, false, `${c.label} must have created_visit=false`);
  }
});

// cliniccard_write_failed — createPatient fails.
test("booking.apply: returns cliniccard_write_failed when createPatient fails", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        createPatient: async () => ({
          ok: false,
          error: { code: "cliniccard_api_error", message: "Duplicate phone" },
        }),
      }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "cliniccard_write_failed");
  assert.match(result.data.reason, /Duplicate phone/);
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// cliniccard_write_failed — createVisit fails.
test("booking.apply: returns cliniccard_write_failed when createVisit fails", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        createVisit: async () => ({
          ok: false,
          error: { code: "cliniccard_api_error", message: "Doctor not available" },
        }),
      }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "cliniccard_write_failed");
  assert.match(result.data.reason, /Doctor not available/);
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// cliniccard_write_failed — fresh availability re-read fails.
test("booking.apply: returns cliniccard_write_failed when availability re-read fails", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        listVisits: async () => ({
          ok: false,
          error: { code: "cliniccard_http_error", message: "HTTP 503" },
        }),
      }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "cliniccard_write_failed");
  assert.match(result.data.reason, /503/);
});

// time_end is computed correctly (10:00 + 30 min = 10:30).
test("booking.apply: computes time_end as time_start + 30 minutes", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        createVisit: async (input) => ({
          ok: true,
          data: {
            id: 1,
            patient_id: 42,
            doctor_id: input.doctor_id,
            cabinet_id: input.cabinet_id,
            date: input.date,
            time_start: input.time_start,
            time_end: input.time_end,
            status: input.status,
          },
        }),
      }),
  });

  const result = await executor(makeContext({ requested_time: "14:45" }));
  assert.equal(result.data.time_start, "14:45");
  assert.equal(result.data.time_end, "15:15");
});

// Fresh availability is re-read immediately before write (not trusted from context).
test("booking.apply: calls listVisits to re-read availability before every write", async () => {
  let listVisitsCalled = false;
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        listVisits: async () => {
          listVisitsCalled = true;
          return { ok: true, data: [] };
        },
      }),
  });

  await executor(makeContext());
  assert.equal(listVisitsCalled, true, "listVisits must be called before createVisit");
});

// Fix 2: Strict HH:MM validation.
test("booking.apply: returns config_missing for invalid time '10am'", async () => {
  const executor = createBookingApplyExecutor({ env: LIVE_ENV, adapterFactory: () => makeAdapter() });
  const result = await executor(makeContext({ requested_time: "10am" }));
  assert.equal(result.data.booking_status, "config_missing");
  assert.match(result.data.reason, /HH:MM/);
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

test("booking.apply: returns config_missing for single-digit hour '9:00'", async () => {
  const executor = createBookingApplyExecutor({ env: LIVE_ENV, adapterFactory: () => makeAdapter() });
  const result = await executor(makeContext({ requested_time: "9:00" }));
  assert.equal(result.data.booking_status, "config_missing");
  assert.match(result.data.reason, /HH:MM/);
});

test("booking.apply: returns config_missing for natural-language time 'morning'", async () => {
  const executor = createBookingApplyExecutor({ env: LIVE_ENV, adapterFactory: () => makeAdapter() });
  const result = await executor(makeContext({ requested_time: "morning" }));
  assert.equal(result.data.booking_status, "config_missing");
  assert.match(result.data.reason, /HH:MM/);
});

test("booking.apply: accepts strict HH:MM '09:00' and proceeds to visit_created", async () => {
  const executor = createBookingApplyExecutor({ env: LIVE_ENV, adapterFactory: () => makeAdapter() });
  const result = await executor(makeContext({ requested_time: "09:00" }));
  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(result.data.time_start, "09:00");
  assert.equal(result.data.time_end, "09:30");
});

// Fix 3: Reuse existing patient by phone.
test("booking.apply: reuses existing patient when findPatientByPhone returns a match", async () => {
  let createPatientCalled = false;
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        findPatientByPhone: async () => ({
          ok: true,
          data: [{ id: 55, name: "Ivan Petrov", phone: "+420777123456" }],
        }),
        createPatient: async () => {
          createPatientCalled = true;
          return { ok: true, data: { id: 99, name: "Should not reach here" } };
        },
      }),
  });

  const result = await executor(makeContext());
  assert.equal(createPatientCalled, false, "createPatient must not be called when patient exists");
  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(result.data.cliniccard_patient_id, 55);
});

test("booking.apply: calls createPatient when findPatientByPhone returns empty list", async () => {
  let createPatientCalled = false;
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        findPatientByPhone: async () => ({ ok: true, data: [] }),
        createPatient: async (input) => {
          createPatientCalled = true;
          return { ok: true, data: { id: 42, name: input.name } };
        },
      }),
  });

  const result = await executor(makeContext());
  assert.equal(createPatientCalled, true);
  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(result.data.cliniccard_patient_id, 42);
});

test("booking.apply: returns cliniccard_write_failed when findPatientByPhone fails", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () =>
      makeAdapter({
        findPatientByPhone: async () => ({
          ok: false,
          error: { code: "cliniccard_http_error", message: "HTTP 502" },
        }),
      }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "cliniccard_write_failed");
  assert.match(result.data.reason, /Patient lookup failed/);
  assert.equal(result.data.created_visit, false);
});

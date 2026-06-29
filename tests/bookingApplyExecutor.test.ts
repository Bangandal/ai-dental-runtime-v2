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

// Path 1: booking_write_disabled — mode is not live.
test("booking.apply: returns booking_write_disabled when mode is not live", async () => {
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
  assert.match(result.data.reason ?? "", /disabled/);
});

// Path 1b: shadow mode also triggers booking_write_disabled.
test("booking.apply: shadow mode also returns booking_write_disabled", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "shadow" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "booking_write_disabled");
});

// Path 2: missing_phone — channel_contact not set.
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

// Path 3: config_missing — doctor_id not set.
test("booking.apply: returns config_missing when CLINICCARD_DEFAULT_DOCTOR_ID is absent", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "config_missing");
  assert.match(result.data.reason ?? "", /DOCTOR_ID/);
});

// Path 3b: config_missing — cabinet_id not set.
test("booking.apply: returns config_missing when CLINICCARD_DEFAULT_CABINET_ID is absent", async () => {
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_CABINET_ID: "0" },
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "config_missing");
  assert.match(result.data.reason ?? "", /CABINET_ID/);
});

// Path 4: availability_conflict — overlapping visit for same doctor.
test("booking.apply: returns availability_conflict when doctor slot is taken", async () => {
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
  assert.equal(result.data.booking_status, "availability_conflict");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// Path 4b: no conflict when a visit for a different doctor AND different cabinet.
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

// Path 5: visit_created — full happy path.
test("booking.apply: returns visit_created with proof on success", async () => {
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
  assert.equal(result.data.cliniccard_visit_id, 99);
  assert.equal(result.data.cliniccard_patient_id, 42);
  assert.equal(result.data.date, "2026-07-15");
  assert.equal(result.data.time_start, "10:00");
  assert.equal(result.data.time_end, "10:30");
  assert.equal(result.data.doctor_id, 1);
  assert.equal(result.data.cabinet_id, 2);
  assert.equal(result.data.timezone, "Europe/Prague");
  assert.equal(result.data.reason, null);
  assert.ok(result.data.proof !== null);

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

// validation_error — missing required fields.
test("booking.apply: returns validation_error when required fields are missing", async () => {
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });

  const result = await executor(makeContext({ first_name: undefined, last_name: undefined }));
  assert.equal(result.data.booking_status, "validation_error");
  assert.match(result.data.reason ?? "", /first_name/);
  assert.match(result.data.reason ?? "", /last_name/);
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// patient_create_failed — adapter returns error.
test("booking.apply: returns patient_create_failed when createPatient fails", async () => {
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
  assert.equal(result.data.booking_status, "patient_create_failed");
  assert.match(result.data.reason ?? "", /Duplicate phone/);
  assert.equal(result.data.created_visit, false);
});

// visit_create_failed — adapter returns error on createVisit.
test("booking.apply: returns visit_create_failed when createVisit fails", async () => {
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
  assert.equal(result.data.booking_status, "visit_create_failed");
  assert.match(result.data.reason ?? "", /Doctor not available/);
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
});

// cliniccard_unavailable — listVisits fails.
test("booking.apply: returns cliniccard_unavailable when listVisits fails", async () => {
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
  assert.equal(result.data.booking_status, "cliniccard_unavailable");
  assert.match(result.data.reason ?? "", /503/);
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

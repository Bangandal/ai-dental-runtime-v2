import assert from "node:assert/strict";
import test from "node:test";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import { resolveClinicCardBookingSlotPolicy } from "../src/integrations/cliniccard/clinicCardBookingSlotPolicy.ts";

const LIVE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_DEFAULT_DOCTOR_ID: "7",
  CLINICCARD_DEFAULT_CABINET_ID: "3",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5",
  CLINICCARD_WORKING_HOURS_START: "10:00",
  CLINICCARD_WORKING_HOURS_END: "12:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "60",
  CLINICCARD_CLOSED_DATES: "",
};

function bookingContext(overrides: Record<string, unknown> = {}) {
  return {
    clinic_id: "clinic_1",
    phone_number: "+420777123456",
    phone_source: "telegram_contact_button",
    phone_belongs_to_patient: true,
    first_name: "Ivan",
    last_name: "Petrov",
    requested_date: "2026-08-24",
    requested_time: "10:00",
    service_interest: "Cleaning",
    ...overrides,
  };
}

function executorWithNoExternalAccess(env: Record<string, string | undefined>) {
  let adapterCreated = false;
  const executor = createBookingApplyExecutor({
    env,
    adapterFactory: () => {
      adapterCreated = true;
      throw new Error("ClinicCard adapter must not be created for a policy-rejected slot");
    },
  });
  return { executor, adapterCreated: () => adapterCreated };
}

test("PF-007b: missing schedule policy fails closed before ClinicCard access", async () => {
  const env: Record<string, string | undefined> = { ...LIVE_ENV };
  delete env.CLINICCARD_AVAILABILITY_POLICY_CONFIRMED;

  const { executor, adapterCreated } = executorWithNoExternalAccess(env);
  const result = await executor(bookingContext());

  assert.equal(adapterCreated(), false);
  assert.equal(result.status, "success");
  assert.equal((result.data as Record<string, unknown>).booking_status, "config_missing");
  assert.equal((result.data as Record<string, unknown>).created_visit, false);
  assert.equal((result.data as Record<string, unknown>).may_claim_booked, false);
});

test("PF-007b: closed/non-working date is rejected before ClinicCard access", async () => {
  const { executor, adapterCreated } = executorWithNoExternalAccess(LIVE_ENV);
  const result = await executor(bookingContext({ requested_date: "2026-08-23" })); // Sunday

  assert.equal(adapterCreated(), false);
  assert.equal((result.data as Record<string, unknown>).booking_status, "slot_conflict");
  assert.match(String((result.data as Record<string, unknown>).reason), /not an open clinic date/);
});

test("PF-007b: slot before working hours is rejected before ClinicCard access", async () => {
  const { executor, adapterCreated } = executorWithNoExternalAccess(LIVE_ENV);
  const result = await executor(bookingContext({ requested_time: "09:00" }));

  assert.equal(adapterCreated(), false);
  assert.equal((result.data as Record<string, unknown>).booking_status, "slot_conflict");
  assert.match(String((result.data as Record<string, unknown>).reason), /outside confirmed working hours/);
});

test("PF-007b: slot that cannot fit before closing is rejected before ClinicCard access", async () => {
  const { executor, adapterCreated } = executorWithNoExternalAccess(LIVE_ENV);
  const result = await executor(bookingContext({ requested_time: "11:30" }));

  assert.equal(adapterCreated(), false);
  assert.equal((result.data as Record<string, unknown>).booking_status, "slot_conflict");
  assert.match(String((result.data as Record<string, unknown>).reason), /outside confirmed working hours/);
});

test("PF-007b: slot must align to the same configured grid used by availability", async () => {
  const { executor, adapterCreated } = executorWithNoExternalAccess(LIVE_ENV);
  const result = await executor(bookingContext({ requested_time: "10:30" }));

  assert.equal(adapterCreated(), false);
  assert.equal((result.data as Record<string, unknown>).booking_status, "slot_conflict");
  assert.match(String((result.data as Record<string, unknown>).reason), /not aligned/);
});

test("PF-007b: valid booking write uses the exact policy duration, not a hardcoded 30 minutes", async () => {
  let capturedWrite: Record<string, any> | undefined;
  let listVisitsCalls = 0;

  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => ({
      listVisits: async () => {
        listVisitsCalls += 1;
        return { ok: true, data: [] };
      },
    } as any),
    patientIdentityAuthorityFactory: () => ({
      resolve: async () => ({ ok: true, resolution: "existing_patient", patient_id: 42 }),
    }),
    bookingWriteAuthorityFactory: () => ({
      write: async (input) => {
        capturedWrite = input as Record<string, any>;
        return {
          ok: true,
          patient_id: 42,
          visit: {
            id: 99,
            patient_id: 42,
            doctor_id: input.visit.doctor_id,
            cabinet_id: input.visit.cabinet_id,
            date: input.visit.date,
            time_start: input.visit.time_start,
            time_end: input.visit.time_end,
            status: input.visit.status,
            note: input.visit.note ?? null,
          },
        };
      },
    }),
  });

  const result = await executor(bookingContext());

  assert.equal(listVisitsCalls, 1);
  assert.ok(capturedWrite);
  assert.equal(capturedWrite!.visit.time_start, "10:00");
  assert.equal(capturedWrite!.visit.time_end, "11:00");
  assert.equal(result.status, "success");
  assert.equal((result.data as Record<string, unknown>).booking_status, "visit_created");
  assert.equal((result.data as Record<string, unknown>).time_end, "11:00");
});

test("PF-007b: pure slot-policy resolver derives 60-minute end time from the confirmed policy", () => {
  const result = resolveClinicCardBookingSlotPolicy(LIVE_ENV, "2026-08-24", "11:00");
  assert.deepEqual(result, {
    ok: true,
    time_end: "12:00",
    duration_minutes: 60,
  });
});

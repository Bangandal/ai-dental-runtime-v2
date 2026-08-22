import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import { createInMemoryBookingProcessStateRepository } from "../src/runtime/bookingProcessState.ts";
import { createBookingReconciliationCoordinator } from "../src/runtime/bookingReconciliationCoordinator.ts";

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
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  CLINICCARD_AVAILABILITY_POLICY_CONFIRMED: "true",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5,6,7",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "15",
  CLINICCARD_CLOSED_DATES: "",
};

const KEY = { clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1" };

function bookingContext() {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
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

test("PF-012 recovery: exact ClinicCard visit proves earlier unknown write without a second POST", async () => {
  let listVisitsCount = 0;
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
    listVisits: async () => {
      listVisitsCount += 1;
      if (listVisitsCount === 1) return { ok: true, data: [] };
      return {
        ok: true,
        data: [{
          id: 777,
          patient_id: 33,
          doctor_id: 10,
          cabinet_id: 20,
          date: "2099-08-21",
          time_start: "10:00",
          time_end: "10:30",
          status: "PLANNED" as const,
        }],
      };
    },
    createVisit: async () => {
      createVisitCount += 1;
      return {
        ok: false,
        error: { code: "cliniccard_timeout", message: "response lost after possible commit" },
      };
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const coordinator = createBookingReconciliationCoordinator(createInMemoryBookingProcessStateRepository());
  const executor = createBookingApplyExecutor({
    env: ENV,
    adapterFactory: () => adapter,
    bookingReconciliationGuard: coordinator.guard,
  });

  const first = await executor(bookingContext());
  assert.equal(first.data.booking_status, "booking_outcome_unknown");
  assert.equal(createVisitCount, 1);

  const second = await executor(bookingContext());
  assert.equal(second.data.booking_status, "visit_created");
  assert.equal(second.data.created_visit, true);
  assert.equal(second.data.may_claim_booked, true);
  assert.equal(second.data.cliniccard_visit_id, "777");
  assert.equal(second.data.proof?.reconciled_after_unknown_write, true);
  assert.equal(createVisitCount, 1, "reconciliation must never issue a second createVisit POST");
  assert.equal(listVisitsCount, 2);

  const pending = await coordinator.guard.getPending(KEY);
  assert.deepEqual(pending, { ok: true, lock: null });
});

test("PF-012 recovery: patient id from a new-patient visit timeout is durably attached to the pending lock", async () => {
  const adapter: ClinicCardAdapter = {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async (input) => ({
      ok: true,
      data: { id: 44, name: input.name, phone: input.phone ?? null },
    }),
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => ({
      ok: false,
      error: { code: "cliniccard_timeout", message: "visit response lost" },
    }),
    listPayments: async () => ({ ok: true, data: [] }),
  };

  const coordinator = createBookingReconciliationCoordinator(createInMemoryBookingProcessStateRepository());
  const executor = createBookingApplyExecutor({
    env: ENV,
    adapterFactory: () => adapter,
    bookingReconciliationGuard: coordinator.guard,
  });

  const result = await executor(bookingContext());
  assert.equal(result.data.booking_status, "booking_outcome_unknown");
  assert.equal(result.data.cliniccard_patient_id, 44);

  const pending = await coordinator.guard.getPending(KEY);
  assert.equal(pending.ok, true);
  if (pending.ok) {
    assert.equal(pending.lock?.patient_id, 44);
    assert.equal(pending.lock?.date, "2099-08-21");
    assert.equal(pending.lock?.time_start, "10:00");
    assert.equal(pending.lock?.time_end, "10:30");
  }
});
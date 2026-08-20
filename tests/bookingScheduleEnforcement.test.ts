import assert from "node:assert/strict";
import test from "node:test";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "test-token",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
  CLINICCARD_WORKING_DAYS: "1,2,3,4,5",
  CLINICCARD_WORKING_HOURS_START: "09:00",
  CLINICCARD_WORKING_HOURS_END: "18:00",
  CLINICCARD_SLOT_DURATION_MINUTES: "30",
  CLINICCARD_HOLIDAYS: "",
};

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    first_name: "Ivan",
    last_name: "Petrov",
    service_interest: "consultation",
    requested_date: "2026-08-21",
    requested_time: "10:00",
    phone_number: "+420777111222",
    phone_source: "telegram_contact_button",
    ...overrides,
  };
}

function adapter(onCall?: (name: string) => void): ClinicCardAdapter {
  return {
    listVisits: async () => { onCall?.("listVisits"); return { ok: true, data: [] }; },
    findPatientByPhone: async () => { onCall?.("findPatientByPhone"); return { ok: true, data: [] }; },
    createPatient: async (input) => { onCall?.("createPatient"); return { ok: true, data: { id: 10, name: input.name, phone: input.phone ?? null } }; },
    createVisit: async (input) => { onCall?.("createVisit"); return { ok: true, data: { id: 20, patient_id: input.patient_id, doctor_id: input.doctor_id, cabinet_id: input.cabinet_id, date: input.date, time_start: input.time_start, time_end: input.time_end, status: input.status } }; },
    listPayments: async () => ({ ok: true, data: [] }),
  };
}

test("SCHEDULE-WRITE-1: missing explicit schedule fails closed before ClinicCard I/O", async () => {
  const env: Record<string, string | undefined> = { ...ENV };
  delete env.CLINICCARD_WORKING_DAYS;
  const calls: string[] = [];
  const executor = createBookingApplyExecutor({ env, adapterFactory: () => adapter((name) => calls.push(name)) });
  const result = await executor(context());
  assert.equal(result.data.booking_status, "config_missing");
  assert.equal(result.data.created_visit, false);
  assert.deepEqual(calls, []);
});

test("SCHEDULE-WRITE-2: configured holiday cannot be written", async () => {
  const calls: string[] = [];
  const executor = createBookingApplyExecutor({
    env: { ...ENV, CLINICCARD_HOLIDAYS: "2026-08-21" },
    adapterFactory: () => adapter((name) => calls.push(name)),
  });
  const result = await executor(context());
  assert.equal(result.data.booking_status, "invalid_slot");
  assert.equal(result.data.created_visit, false);
  assert.deepEqual(calls, []);
});

test("SCHEDULE-WRITE-3: configured duration is used by the ClinicCard visit", async () => {
  let createdEnd: string | null = null;
  const base = adapter();
  const executor = createBookingApplyExecutor({
    env: { ...ENV, CLINICCARD_SLOT_DURATION_MINUTES: "60" },
    adapterFactory: () => ({
      ...base,
      createVisit: async (input) => {
        createdEnd = input.time_end;
        return { ok: true, data: { id: 20, patient_id: input.patient_id, doctor_id: input.doctor_id, cabinet_id: input.cabinet_id, date: input.date, time_start: input.time_start, time_end: input.time_end, status: input.status } };
      },
    }),
  });
  const result = await executor(context({ requested_time: "14:00" }));
  assert.equal(result.data.booking_status, "visit_created");
  assert.equal(createdEnd, "15:00");
});

test("SCHEDULE-WRITE-4: slot crossing closing time fails before ClinicCard I/O", async () => {
  const calls: string[] = [];
  const executor = createBookingApplyExecutor({
    env: { ...ENV, CLINICCARD_SLOT_DURATION_MINUTES: "60" },
    adapterFactory: () => adapter((name) => calls.push(name)),
  });
  const result = await executor(context({ requested_time: "17:30" }));
  assert.equal(result.data.booking_status, "invalid_slot");
  assert.equal(result.data.created_visit, false);
  assert.deepEqual(calls, []);
});

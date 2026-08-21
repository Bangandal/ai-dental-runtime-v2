import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardCreatePatientInput, ClinicCardCreateVisitInput, ClinicCardPatient } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

const LIVE_ENV: Record<string, string> = {
  ...clinicCardServiceAuthorityEnv({ service_key: "consultation", aliases: ["consultation"], doctor_id: 10, cabinet_id: 20, duration_minutes: 30 }),

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

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    first_name: "Anna",
    last_name: "Koval",
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    requested_date: "2099-08-21",
    requested_time: "10:00",
    service_interest: "consultation",
    ...overrides,
  };
}

function makeAdapter(params: {
  patients: ClinicCardPatient[];
  newPatientId?: number;
  onCreatePatient?: (input: ClinicCardCreatePatientInput) => void;
  onCreateVisit?: (input: ClinicCardCreateVisitInput) => void;
}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => ({ ok: true, data: params.patients }),
    createPatient: async (input) => {
      params.onCreatePatient?.(input);
      return {
        ok: true,
        data: {
          id: params.newPatientId ?? 900,
          name: input.name,
          phone: input.phone ?? null,
        },
      };
    },
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async (input) => {
      params.onCreateVisit?.(input);
      return {
        ok: true,
        data: {
          id: 700,
          patient_id: input.patient_id,
          doctor_id: input.doctor_id,
          cabinet_id: input.cabinet_id,
          date: input.date,
          time_start: input.time_start,
          time_end: input.time_end,
          status: input.status,
          note: input.note ?? null,
        },
      };
    },
    listPayments: async () => ({ ok: true, data: [] }),
  };
}

async function runWithAdapter(adapter: ClinicCardAdapter, context: ToolExecutionContext) {
  const executor = createBookingApplyExecutor({ env: LIVE_ENV, adapterFactory: () => adapter });
  const result = await executor(context);
  assert.equal(result.tool, "booking.apply");
  assert.equal(result.status, "success");
  return result.data as Record<string, unknown>;
}

test("IDENTITY-SAFE-1: marker absent + phone belongs to different named patient never reuses that patient", async () => {
  let createPatientCalled = false;
  let createVisitCalled = false;
  const adapter = makeAdapter({
    patients: [{ id: 10, name: "Olena Koval", phone: "+420111222333" }],
    onCreatePatient: () => { createPatientCalled = true; },
    onCreateVisit: () => { createVisitCalled = true; },
  });

  const data = await runWithAdapter(adapter, makeContext());
  assert.equal(data.booking_status, "identity_ambiguous");
  assert.equal(data.created_visit, false);
  assert.equal(data.may_claim_booked, false);
  assert.equal(createPatientCalled, false);
  assert.equal(createVisitCalled, false);
});

test("IDENTITY-SAFE-2: borrowed responsible-party phone + only owner exists creates separate target patient", async () => {
  let createdPatient: ClinicCardCreatePatientInput | null = null;
  let createdVisit: ClinicCardCreateVisitInput | null = null;
  const adapter = makeAdapter({
    patients: [{ id: 10, name: "Olena Koval", phone: "+420111222333" }],
    newPatientId: 55,
    onCreatePatient: (input) => { createdPatient = input; },
    onCreateVisit: (input) => { createdVisit = input; },
  });

  const data = await runWithAdapter(
    adapter,
    makeContext({ contact_phone_owner_subject_id: "subject_1" }),
  );

  assert.equal(data.booking_status, "visit_created");
  assert.equal(data.cliniccard_patient_id, 55);
  assert.equal(createdPatient?.name, "Anna Koval");
  assert.equal(createdVisit?.patient_id, 55);
  assert.notEqual(createdVisit?.patient_id, 10, "visit must never attach to responsible-party patient record");
});

test("IDENTITY-SAFE-3: exactly one phone candidate matching target name is reused", async () => {
  let createdVisit: ClinicCardCreateVisitInput | null = null;
  const adapter = makeAdapter({
    patients: [{ id: 33, name: "Koval Anna", phone: "+420111222333" }],
    onCreateVisit: (input) => { createdVisit = input; },
  });

  const data = await runWithAdapter(adapter, makeContext());
  assert.equal(data.booking_status, "visit_created");
  assert.equal(data.cliniccard_patient_id, 33);
  assert.equal(createdVisit?.patient_id, 33);
});

test("IDENTITY-SAFE-4: multiple phone candidates but one target-name match reuses only the matching target", async () => {
  let createdVisit: ClinicCardCreateVisitInput | null = null;
  const adapter = makeAdapter({
    patients: [
      { id: 10, name: "Olena Koval", phone: "+420111222333" },
      { id: 44, name: "Anna Koval", phone: "+420111222333" },
    ],
    onCreateVisit: (input) => { createdVisit = input; },
  });

  const data = await runWithAdapter(adapter, makeContext({ contact_phone_owner_subject_id: "subject_1" }));
  assert.equal(data.booking_status, "visit_created");
  assert.equal(data.cliniccard_patient_id, 44);
  assert.equal(createdVisit?.patient_id, 44);
});

test("IDENTITY-SAFE-5: multiple target-name matches fail closed and create no visit", async () => {
  let createVisitCalled = false;
  const adapter = makeAdapter({
    patients: [
      { id: 44, name: "Anna Koval", phone: "+420111222333" },
      { id: 45, name: "Koval Anna", phone: "+420111222333" },
    ],
    onCreateVisit: () => { createVisitCalled = true; },
  });

  const data = await runWithAdapter(adapter, makeContext({ contact_phone_owner_subject_id: "subject_1" }));
  assert.equal(data.booking_status, "identity_ambiguous");
  assert.equal(data.created_visit, false);
  assert.equal(createVisitCalled, false);
});

test("IDENTITY-SAFE-6: identity_ambiguous maps to admin_handoff with no booking claim", () => {
  const toolResult: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: "call-1",
    status: "success",
    data: {
      booking_action: "booking_apply",
      booking_status: "identity_ambiguous",
      created_visit: false,
      may_claim_booked: false,
      cliniccard_visit_id: null,
      reason: "ambiguous patient identity",
      proof: null,
    },
  };

  const truth = buildBookingApplyActionTruth([toolResult]);
  assert.ok(truth);
  assert.equal(truth.required_next_action, "admin_handoff");
  assert.equal(truth.allowed_claims.can_say_booking_created, false);
  assert.equal(truth.allowed_claims.can_say_booking_confirmed, false);
});

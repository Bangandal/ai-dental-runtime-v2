import assert from "node:assert/strict";
import test from "node:test";

import { clinicCardServiceAuthorityEnv } from "./clinicCardServiceAuthorityTestHelper.ts";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import {
  AVAILABILITY_MODEL_VISIBILITY_TTL_MS,
  buildModelVisibleBookingProcessState,
  type BookingProcessState,
} from "../src/runtime/bookingProcessState.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const ENV: Record<string, string> = {
  ...clinicCardServiceAuthorityEnv({ service_key: "tooth-pain", aliases: ["зубная боль"], doctor_id: 10, cabinet_id: 20, duration_minutes: 30 }),

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

const DATE = "2099-08-21";
const TIME = "14:00";
const NOW = new Date("2026-08-21T12:00:00.000Z");
const STALE_CHECKED_AT = new Date(
  NOW.getTime() - AVAILABILITY_MODEL_VISIBILITY_TTL_MS - 60_000,
).toISOString();

function staleBookingState(): BookingProcessState {
  return {
    service_reason: "зубная боль",
    first_name: "Anna",
    last_name: "Koval",
    proof: {
      service_known: true,
      name_known: true,
      slot_known: true,
      trusted_phone_known: true,
      ready_for_booking_apply: true,
    },
    active_availability_evidence: {
      availability_call_id: "old-availability-call",
      requested_date: DATE,
      requested_time: TIME,
      allowed_slot_keys: [`${DATE}T${TIME}`],
      checked_at: STALE_CHECKED_AT,
    },
    last_available_slots: [{ starts_at: `${DATE}T${TIME}:00` }],
    selected_slot: { starts_at: `${DATE}T${TIME}:00` },
    next_action: "ready_for_booking_apply",
  };
}

function bookingContext(): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    first_name: "Anna",
    last_name: "Koval",
    service_interest: "зубная боль",
    requested_date: DATE,
    requested_time: TIME,
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
    phone_belongs_to_patient: true,
  };
}

test("PF-002 GOLDEN: stale offer stays conversational memory, but a newly occupied slot cannot be written", async () => {
  // The stale offer is not exposed to the model as current availability, while
  // durable patient facts survive the TTL boundary.
  const visible = buildModelVisibleBookingProcessState({
    state: staleBookingState(),
    priorProcessState: null,
    bookingStateGrounded: true,
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(visible.service_reason, "зубная боль");
  assert.equal(visible.first_name, "Anna");
  assert.equal(visible.last_name, "Koval");
  assert.equal(visible.slot_evidence_status, "stale");
  assert.equal(visible.selected_slot, undefined);
  assert.deepEqual(visible.last_available_slots, []);
  assert.equal(visible.proof?.slot_known, false);
  assert.equal(visible.proof?.ready_for_booking_apply, false);

  // At the write boundary, the old offer itself grants no authority. ClinicCard
  // is read again under the booking lock. If the slot has since been occupied,
  // booking fails closed before patient resolution or any external write.
  const calls: string[] = [];
  const adapter: ClinicCardAdapter = {
    listVisits: async () => {
      calls.push("listVisits");
      return {
        ok: true,
        data: [{
          id: 501,
          patient_id: 77,
          doctor_id: 10,
          cabinet_id: 99,
          date: DATE,
          time_start: "14:00",
          time_end: "14:30",
          status: "PLANNED",
        }],
      };
    },
    findPatientByPhone: async () => {
      calls.push("findPatientByPhone");
      return { ok: true, data: [{ id: 33, name: "Anna Koval", phone: "+420111222333" }] };
    },
    createPatient: async (input) => {
      calls.push("createPatient");
      return { ok: true, data: { id: 33, name: input.name, phone: input.phone ?? null } };
    },
    createVisit: async (input) => {
      calls.push("createVisit");
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

  const executor = createBookingApplyExecutor({
    env: ENV,
    adapterFactory: () => adapter,
  });
  const result = await executor(bookingContext());

  assert.equal(result.status, "success");
  assert.equal(result.data.booking_status, "slot_conflict");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.equal(result.data.cliniccard_visit_id, null);
  assert.deepEqual(
    calls,
    ["listVisits"],
    "fresh availability must be read first and a conflict must stop identity lookup and all writes",
  );
});

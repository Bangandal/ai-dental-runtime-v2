import assert from "node:assert/strict";
import test from "node:test";

import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type {
  ClinicCardCreatePatientInput,
  ClinicCardCreateVisitInput,
  ClinicCardPatient,
} from "../src/integrations/cliniccard/clinicCardTypes.ts";
import { buildBookingApplyActionTruth } from "../src/runtime/bookingApplyGuard.ts";
import {
  buildModelVisibleBookingProcessState,
  type BookingProcessState,
} from "../src/runtime/bookingProcessState.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";
import type { AvailabilityEvidence } from "../src/runtime/slotEvidence.ts";

/**
 * R0 Golden Reliability Suite
 *
 * Purpose: freeze business-level safety outcomes before structural refactor.
 * This file intentionally does NOT change production behavior and avoids
 * assertions about model round numbers, internal prompt text, or implementation
 * layout unless the invariant itself requires it.
 *
 * Open reliability classes remain explicit test.todo entries so future refactor
 * work cannot quietly forget them.
 */

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
  patients?: ClinicCardPatient[];
  newPatientId?: number;
  createVisitFailure?: { code: string; message: string } | null;
  onCreatePatient?: (input: ClinicCardCreatePatientInput) => void;
  onCreateVisit?: (input: ClinicCardCreateVisitInput) => void;
} = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => ({ ok: true, data: params.patients ?? [] }),
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
      if (params.createVisitFailure) {
        return { ok: false, error: params.createVisitFailure };
      }
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

async function runBooking(adapter: ClinicCardAdapter, context: ToolExecutionContext) {
  const executor = createBookingApplyExecutor({ env: LIVE_ENV, adapterFactory: () => adapter });
  const result = await executor(context);
  assert.equal(result.tool, "booking.apply");
  assert.equal(result.status, "success");
  return result.data as Record<string, unknown>;
}

function bookingToolResult(data: Record<string, unknown>): RuntimeAgentToolResult {
  return {
    tool: "booking.apply",
    call_id: "golden-call",
    status: "success",
    data,
  };
}

// PF-006 + base booking success: a unique, matching patient identity is safe to reuse.
test("GOLDEN-01 self booking: exactly one visit is written to the uniquely matched patient", async () => {
  const visits: ClinicCardCreateVisitInput[] = [];
  const adapter = makeAdapter({
    patients: [{ id: 33, name: "Anna Koval", phone: "+420111222333" }],
    onCreateVisit: (input) => visits.push(input),
  });

  const data = await runBooking(adapter, makeContext({ phone_belongs_to_patient: true }));

  assert.equal(data.booking_status, "visit_created");
  assert.equal(data.created_visit, true);
  assert.equal(data.may_claim_booked, true);
  assert.equal(data.cliniccard_patient_id, 33);
  assert.equal(visits.length, 1);
  assert.equal(visits[0]?.patient_id, 33);
  assert.equal(visits[0]?.date, "2099-08-21");
  assert.equal(visits[0]?.time_start, "10:00");
});

// PF-010: a contact phone owned by another person is contact authority, not target-patient identity.
test("GOLDEN-02 third-party booking: another person's phone never attaches the visit to that person", async () => {
  let createdPatient: ClinicCardCreatePatientInput | null = null;
  const visits: ClinicCardCreateVisitInput[] = [];
  const adapter = makeAdapter({
    patients: [{ id: 10, name: "Olena Koval", phone: "+420111222333" }],
    newPatientId: 55,
    onCreatePatient: (input) => { createdPatient = input; },
    onCreateVisit: (input) => visits.push(input),
  });

  const data = await runBooking(
    adapter,
    makeContext({ phone_belongs_to_patient: false }),
  );

  assert.equal(data.booking_status, "visit_created");
  assert.equal(data.cliniccard_patient_id, 55);
  assert.equal(createdPatient?.name, "Anna Koval");
  assert.equal(visits.length, 1);
  assert.equal(visits[0]?.patient_id, 55);
  assert.notEqual(visits[0]?.patient_id, 10);
});

// PF-006: ambiguous target identity fails closed and cannot produce a booking claim.
test("GOLDEN-03 ambiguous target on another person's phone: no visit is written and next action is admin handoff", async () => {
  let createVisitCount = 0;
  const adapter = makeAdapter({
    patients: [
      { id: 44, name: "Anna Koval", phone: "+420111222333" },
      { id: 45, name: "Koval Anna", phone: "+420111222333" },
    ],
    onCreateVisit: () => { createVisitCount += 1; },
  });

  const data = await runBooking(
    adapter,
    makeContext({ phone_belongs_to_patient: false }),
  );

  assert.equal(data.booking_status, "identity_ambiguous");
  assert.equal(data.created_visit, false);
  assert.equal(data.may_claim_booked, false);
  assert.equal(createVisitCount, 0);

  const truth = buildBookingApplyActionTruth([bookingToolResult(data)]);
  assert.ok(truth);
  assert.equal(truth.required_next_action, "admin_handoff");
  assert.equal(truth.allowed_claims.can_say_booking_created, false);
  assert.equal(truth.allowed_claims.can_say_booking_confirmed, false);
});

// PF-002 characterization: stale offer memory may exist internally, but it is not booking authority.
test("GOLDEN-04 stale availability: stale slot evidence cannot remain booking-ready to the model", () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const staleCheckedAt = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
  const evidence: AvailabilityEvidence = {
    availability_call_id: "availability-golden-1",
    requested_date: "2026-08-12",
    requested_time: "14:00",
    allowed_slot_keys: ["2026-08-12T14:00"],
    checked_at: staleCheckedAt,
  };
  const state: BookingProcessState = {
    proof: {
      service_known: true,
      name_known: true,
      slot_known: true,
      trusted_phone_known: true,
      ready_for_booking_apply: true,
    },
    active_availability_evidence: evidence,
    last_available_slots: [{ starts_at: "2026-08-12T14:00:00" }],
    selected_slot: { starts_at: "2026-08-12T14:00:00" },
    next_action: "ready_for_booking_apply",
  };

  const visible = buildModelVisibleBookingProcessState({
    state,
    priorProcessState: null,
    bookingStateGrounded: true,
    now,
    timezone: "Europe/Prague",
  });

  assert.equal(visible.slot_evidence_status, "stale");
  assert.equal(visible.proof?.slot_known, false);
  assert.equal(visible.proof?.ready_for_booking_apply, false);
  assert.equal(visible.selected_slot, undefined);
  assert.deepEqual(visible.last_available_slots, []);
  assert.notEqual(visible.next_action, "ready_for_booking_apply");
});

// PF-012: external write failure can never be converted into a success claim.
test("GOLDEN-05 ClinicCard booking failure: no success claim and no fabricated visit id", async () => {
  const adapter = makeAdapter({
    patients: [{ id: 33, name: "Anna Koval", phone: "+420111222333" }],
    createVisitFailure: { code: "cliniccard_timeout", message: "timeout" },
  });

  const data = await runBooking(adapter, makeContext({ phone_belongs_to_patient: true }));

  assert.equal(data.booking_status, "cliniccard_write_failed");
  assert.equal(data.created_visit, false);
  assert.equal(data.may_claim_booked, false);
  assert.equal(data.cliniccard_visit_id, null);

  const truth = buildBookingApplyActionTruth([bookingToolResult(data)]);
  assert.ok(truth);
  assert.equal(truth.allowed_claims.can_say_booking_created, false);
  assert.equal(truth.allowed_claims.can_say_booking_confirmed, false);
});

// Open Reliability Matrix items. These are intentionally visible before the refactor starts.
test.todo("PF-003 GOLDEN: exact patient-requested time outside active evidence is rechecked, then nearest alternatives are offered if unavailable");
test.todo("PF-004 GOLDEN: slot-selection legality depends on explicit patient choice + active evidence, not model round number");
test.todo("PF-005 GOLDEN: missing/ambiguous requested date gets deterministic recovery and never becomes an availability claim");
test.todo("PF-007 GOLDEN: presented availability is backed by authoritative ClinicCard schedule/provider/resource truth, not absence of visits alone");
test.todo("PF-008 GOLDEN: two rapid distinct turns for one contact cannot roll back state or create a duplicate visit");
test.todo("PF-009 GOLDEN: losing/resetting the OpenAI conversation thread preserves persisted business facts and safe continuation");
test.todo("PF-011 GOLDEN: service determines authoritative provider/resource/duration before availability and booking");

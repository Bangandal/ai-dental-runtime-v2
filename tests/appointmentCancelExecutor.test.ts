import assert from "node:assert/strict";
import test from "node:test";
import { createAppointmentCancelExecutor } from "../src/integrations/cliniccard/appointmentCancelExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ClinicCardConfig, ClinicCardPatient, ClinicCardVisit } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";
import type { AppointmentCancelSuccessResult, AppointmentLookupResult } from "../src/runtime/toolResults.ts";

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
const VISIT_ID = "99";

const SINGLE_MATCH_PROOF: AppointmentLookupResult = {
  appointment_action: "appointment_lookup",
  lookup_status: "single_match",
  may_claim_found: true,
  required_next_action: "none",
  appointments: [
    {
      cliniccard_visit_id: VISIT_ID,
      date: "2026-08-15",
      time_start: "10:00",
      time_end: "10:30",
      status: "PLANNED",
    },
  ],
  searched_range: { date_from: "2026-07-27", date_to: "2026-12-31" },
};

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    phone_number: "+420777123456",
    phone_source: "telegram_contact_button",
    cancel_subject_id: "subject_1",
    cancel_visit_id: VISIT_ID,
    cancel_lookup_proof: SINGLE_MATCH_PROOF,
    now: NOW,
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<ClinicCardAdapter> = {}): ClinicCardAdapter {
  return {
    findPatientByPhone: async () => ({ ok: true, data: [] }),
    createPatient: async () => ({ ok: false, error: { code: "not_used", message: "not_used" } }),
    listVisits: async () => ({ ok: true, data: [] }),
    createVisit: async () => ({ ok: false, error: { code: "not_used", message: "not_used" } }),
    listPayments: async () => ({ ok: true, data: [] }),
    deleteVisit: async () => ({ ok: true, data: undefined }),
    ...overrides,
  };
}

function asCancel(result: unknown): AppointmentCancelSuccessResult {
  const r = result as AppointmentCancelSuccessResult;
  assert.equal(r.status, "success");
  assert.equal(r.tool, "appointment.cancel");
  assert.equal(r.data.appointment_action, "appointment_cancel");
  return r;
}

// ── CANCEL-1: Happy path ────────────────────────────────────────────────────

test("CANCEL-1: happy path — single_match proof, delete succeeds, verify confirms absent → cancelled", async () => {
  let deleteCalledWith: string | undefined;
  let listVisitsCalledWith: string[] | undefined;

  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({
      deleteVisit: async (id) => { deleteCalledWith = id; return { ok: true, data: undefined }; },
      // Post-write verification: visit is absent
      listVisits: async (from, to) => { listVisitsCalledWith = [from, to]; return { ok: true, data: [] }; },
    }),
  });

  const r = asCancel(await executor(makeContext()));
  assert.equal(r.data.cancel_status, "cancelled");
  assert.equal(r.data.cancelled, true);
  assert.equal(r.data.may_claim_cancelled, true);
  assert.equal(r.data.cancelled_visit_id, VISIT_ID);
  assert.equal(r.data.required_next_action, "none");
  assert.equal(deleteCalledWith, VISIT_ID);
  // Verification query uses the appointment date from the proof
  assert.deepEqual(listVisitsCalledWith, ["2026-08-15", "2026-08-15"]);
});

// ── CANCEL-2: No lookup proof ───────────────────────────────────────────────

test("CANCEL-2: cancel_lookup_proof is null → lookup_not_verified, no ClinicCard calls", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_lookup_proof: null })));
  assert.equal(r.data.cancel_status, "lookup_not_verified");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(r.data.cancelled_visit_id, null);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-3: lookup_status = multiple_matches ──────────────────────────────

test("CANCEL-3: lookup proof has multiple_matches status → multiple_matches, no write", async () => {
  let deleteCalled = false;
  const proof: AppointmentLookupResult = {
    ...SINGLE_MATCH_PROOF,
    lookup_status: "multiple_matches",
    appointments: [
      { cliniccard_visit_id: "99", date: "2026-08-15", time_start: "10:00", time_end: "10:30", status: "PLANNED" },
      { cliniccard_visit_id: "100", date: "2026-08-20", time_start: "11:00", time_end: "11:30", status: "CONFIRMED" },
    ],
  };
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_lookup_proof: proof })));
  assert.equal(r.data.cancel_status, "multiple_matches");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-4: lookup_status = no_upcoming_appointments ─────────────────────

test("CANCEL-4: lookup proof has no_upcoming_appointments → appointment_not_found, no write", async () => {
  let deleteCalled = false;
  const proof: AppointmentLookupResult = {
    ...SINGLE_MATCH_PROOF,
    lookup_status: "no_upcoming_appointments",
    appointments: [],
  };
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_lookup_proof: proof })));
  assert.equal(r.data.cancel_status, "appointment_not_found");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-5: clinic not in allowlist ──────────────────────────────────────

test("CANCEL-5: clinic_id not in CLINICCARD_LIVE_CLINIC_ALLOWLIST → clinic_not_allowed, no write", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: { ...LIVE_ENV, CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_other" },
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext()));
  assert.equal(r.data.cancel_status, "clinic_not_allowed");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(r.data.cancelled_visit_id, null);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-6: live mode not enabled ────────────────────────────────────────

test("CANCEL-6: CLINICCARD_BOOKING_MODE not 'live' → live_mode_required, no write", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "disabled" },
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext()));
  assert.equal(r.data.cancel_status, "live_mode_required");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-7: no phone → identity_not_verified ─────────────────────────────

test("CANCEL-7: no phone in context → identity_not_verified, no write", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ phone_number: undefined, phone_source: undefined })));
  assert.equal(r.data.cancel_status, "identity_not_verified");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-8: manual_input phone → identity_not_verified ───────────────────

test("CANCEL-8: manual_input phone source → identity_not_verified (typed phone not trusted for cancel)", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ phone_source: "manual_input" })));
  assert.equal(r.data.cancel_status, "identity_not_verified");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-9: whatsapp_sender phone passes identity gate ───────────────────

test("CANCEL-9: whatsapp_sender phone → identity verified → cancel executes", async () => {
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asCancel(await executor(makeContext({ phone_source: "whatsapp_sender" })));
  assert.equal(r.data.cancel_status, "cancelled");
  assert.equal(r.data.cancelled, true);
  assert.equal(r.data.may_claim_cancelled, true);
});

// ── CANCEL-10: existing_cliniccard_patient phone passes identity gate ───────

test("CANCEL-10: existing_cliniccard_patient phone → identity verified → cancel executes", async () => {
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter(),
  });
  const r = asCancel(await executor(makeContext({ phone_source: "existing_cliniccard_patient" })));
  assert.equal(r.data.cancel_status, "cancelled");
  assert.equal(r.data.cancelled, true);
});

// ── CANCEL-11: visit_id mismatch with lookup proof ─────────────────────────

test("CANCEL-11: cancel_visit_id does not match lookup proof appointment → verification_failed, no write", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_visit_id: "999" }))); // proof has "99"
  assert.equal(r.data.cancel_status, "verification_failed");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(r.data.cancelled_visit_id, "999");
  assert.equal(deleteCalled, false);
});

// ── CANCEL-12: deleteVisit API fails ───────────────────────────────────────

test("CANCEL-12: deleteVisit returns error → cliniccard_write_failed", async () => {
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({
      deleteVisit: async () => ({ ok: false, error: { code: "cliniccard_http_error", message: "HTTP 500" } }),
    }),
  });
  const r = asCancel(await executor(makeContext()));
  assert.equal(r.data.cancel_status, "cliniccard_write_failed");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(r.data.cancelled_visit_id, VISIT_ID);
});

// ── CANCEL-13: post-write verification shows visit still present ────────────

test("CANCEL-13: deleteVisit succeeds but listVisits shows visit still present → verification_failed", async () => {
  const lingering: ClinicCardVisit = {
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
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({
      deleteVisit: async () => ({ ok: true, data: undefined }),
      listVisits: async () => ({ ok: true, data: [lingering] }),
    }),
  });
  const r = asCancel(await executor(makeContext()));
  assert.equal(r.data.cancel_status, "verification_failed");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(r.data.required_next_action, "admin_handoff");
});

// ── CANCEL-14: cancel_subject_id missing ───────────────────────────────────

test("CANCEL-14: cancel_subject_id is undefined → subject_resolution_conflict, no write", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_subject_id: undefined })));
  assert.equal(r.data.cancel_status, "subject_resolution_conflict");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-15: cancel_visit_id missing ─────────────────────────────────────

test("CANCEL-15: cancel_visit_id is undefined → verification_failed, no write", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_visit_id: undefined })));
  assert.equal(r.data.cancel_status, "verification_failed");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-16: appointment status not actionable ────────────────────────────

test("CANCEL-16: proof appointment has non-actionable status (UNKNOWN) → appointment_not_actionable, no write", async () => {
  let deleteCalled = false;
  const proof: AppointmentLookupResult = {
    ...SINGLE_MATCH_PROOF,
    appointments: [
      { cliniccard_visit_id: VISIT_ID, date: "2026-08-15", time_start: "10:00", time_end: "10:30", status: "PLANNED" },
    ],
  };
  // Force the status to something non-actionable via type cast
  (proof.appointments[0] as { status: string }).status = "VISITED";
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_lookup_proof: proof })));
  assert.equal(r.data.cancel_status, "appointment_not_actionable");
  assert.equal(r.data.cancelled, false);
  assert.equal(r.data.may_claim_cancelled, false);
  assert.equal(r.data.required_next_action, "admin_handoff");
  assert.equal(deleteCalled, false);
});

// ── CANCEL-17: proof has single_match but appointments array empty ──────────

test("CANCEL-17: proof lookup_status=single_match but appointments array is empty → appointment_not_found", async () => {
  let deleteCalled = false;
  const proof: AppointmentLookupResult = {
    ...SINGLE_MATCH_PROOF,
    lookup_status: "single_match",
    appointments: [], // edge case: should never happen in practice but must be handled safely
  };
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({ cancel_lookup_proof: proof })));
  assert.equal(r.data.cancel_status, "appointment_not_found");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-18: post-write listVisits API fails → still returns cancelled ────

test("CANCEL-18: deleteVisit succeeds, listVisits verification fails with API error → cancelled (trusted delete)", async () => {
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({
      deleteVisit: async () => ({ ok: true, data: undefined }),
      listVisits: async () => ({ ok: false, error: { code: "cliniccard_timeout", message: "timeout" } }),
    }),
  });
  const r = asCancel(await executor(makeContext()));
  // Delete succeeded; verification unavailable — trust the delete and return cancelled.
  assert.equal(r.data.cancel_status, "cancelled");
  assert.equal(r.data.cancelled, true);
  assert.equal(r.data.may_claim_cancelled, true);
  assert.equal(r.data.cancelled_visit_id, VISIT_ID);
});

// ── CANCEL-19: subject_id=subject_2 without booking_subjects registry ───────

test("CANCEL-19: cancel_subject_id='subject_2' with no registry → subject_resolution_conflict", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  const r = asCancel(await executor(makeContext({
    cancel_subject_id: "subject_2",
    lookup_booking_subjects: null, // no registry
  })));
  assert.equal(r.data.cancel_status, "subject_resolution_conflict");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

// ── CANCEL-20: shared_from_subject phone source → identity_not_verified ─────

test("CANCEL-20: shared_from_subject phone source → identity_not_verified (borrowed phone not allowed)", async () => {
  let deleteCalled = false;
  const executor = createAppointmentCancelExecutor({
    env: LIVE_ENV,
    adapterFactory: () => makeAdapter({ deleteVisit: async () => { deleteCalled = true; return { ok: true, data: undefined }; } }),
  });
  // Subject_2 with shared_from_subject booking_contact
  const registry = {
    subjects: [
      {
        id: "subject_1",
        booking_contact: { phone_number: "+420777123456", source: "telegram_contact_button" },
      },
      {
        id: "subject_2",
        booking_contact: {
          phone_number: "+420777123456",
          source: "shared_from_subject",
          owner_subject_id: "subject_1",
        },
      },
    ],
  };
  const r = asCancel(await executor(makeContext({
    cancel_subject_id: "subject_2",
    lookup_booking_subjects: registry,
    phone_number: undefined,
    phone_source: undefined,
  })));
  assert.equal(r.data.cancel_status, "identity_not_verified");
  assert.equal(r.data.cancelled, false);
  assert.equal(deleteCalled, false);
});

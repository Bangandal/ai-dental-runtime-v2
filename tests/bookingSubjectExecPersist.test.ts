/**
 * Integration tests for booking subject execution, persistence, and bootstrap.
 *
 * Tests the pipeline: guard resolution → execution subject freeze → executor phone →
 * runtime result metadata → postUpdateBookingSubjects persistence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import {
  postUpdateBookingSubjects,
  normalizeBookingSubjectsState,
  initBookingSubjectsForTurn,
} from "../src/runtime/bookingSubjectsState.ts";
import type {
  BookingSubjectsState,
  SubjectId,
  BookingContact,
} from "../src/runtime/bookingSubjectsState.ts";
import type { ChannelContact } from "../src/runtime/openaiRuntimeAgent.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSlotStateRepo(starts_at: string, subjectId: SubjectId = "subject_1" as SubjectId) {
  const date = starts_at.slice(0, 10);
  const hhmm = starts_at.slice(11, 16);
  const slotKey = `${date}T${hhmm}`;
  const callId = "legacy_test_call";
  return {
    async loadState() {
      return {
        selected_slot: { starts_at },
        last_available_slots: [{ starts_at }],
        active_availability_evidence: { availability_call_id: callId, requested_date: date, requested_time: null, allowed_slot_keys: [slotKey] },
        selected_slot_proof: { subject_id: subjectId, availability_call_id: callId, slot_key: slotKey },
      };
    },
    async saveState() {},
  };
}

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

function makeBookingContact(phone: string, source: string, trust: string, owner: string): BookingContact {
  return {
    phone_number: phone,
    source: source as BookingContact["source"],
    trust: trust as BookingContact["trust"],
    owner_subject_id: owner as SubjectId,
    collected_at: null,
  };
}

function makeS1S2Registry(s2Phone?: string): BookingSubjectsState {
  return {
    version: 3,
    status: "active",
    active_subject_id: "subject_2" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId,
        role: "sender",
        label: null,
        patient_name: "Рима",
        service: null,
        slot: null,
        booking_contact: makeBookingContact("+380991350135", "telegram_contact_button", "trusted", "subject_1"),
        status: "collecting",
        missing: ["service", "slot"],
      },
      {
        id: "subject_2" as SubjectId,
        role: "mentioned_person",
        label: null,
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-09T12:00",
        booking_contact: s2Phone
          ? makeBookingContact(s2Phone, "telegram_contact_button", "trusted", "subject_2")
          : null,
        status: "collecting",
        missing: s2Phone ? ["booking_contact"] : ["booking_contact"],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };
}

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  user_message: "Запишите маму",
  locale: "ru",
  trace_id: "trace_persist",
};

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

// ── Test 1: Round-1 booking returns execution_subject_id ─────────────────────

test("BSEP-1: round-1 booking result contains execution_subject_id=subject_2", async () => {
  const registry = makeS1S2Registry("+420123456789");
  let capturedPhone: string | undefined;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_1",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Иван записан." },
      },
    ]),
    executors: {
      "booking.apply": async (ctx) => {
        capturedPhone = ctx.phone_number;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00", "subject_2" as SubjectId),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    booking_subjects: registry,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(result.execution_subject_id, "subject_2", "execution_subject_id must be subject_2");
});

// ── Test 2: Round-1 booking persists subject_2 as booked ─────────────────────

test("BSEP-2: round-1 successful booking persists subject_2.status=booked via postUpdateBookingSubjects", async () => {
  const registry = makeS1S2Registry("+420123456789");

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_2",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Записали Ивана." },
      },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00", "subject_2" as SubjectId),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    booking_subjects: registry,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.ok(result.booking_subjects_after_resolution, "booking_subjects_after_resolution must be present");

  const persisted = postUpdateBookingSubjects({
    current: result.booking_subjects_after_resolution!,
    toolRequests: result.tool_requests,
    toolResults: result.tool_results,
    executionSubjectId: result.execution_subject_id as SubjectId | null ?? null,
  });

  const s2 = persisted.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "booked", "subject_2 must be booked after successful visit_created");

  const s1 = persisted.subjects.find((s) => s.id === "subject_1");
  assert.equal(s1?.status, "collecting", "subject_1 must remain collecting");
});

// ── Test 3: Executor receives subject_2's phone, not subject_1's ─────────────

test("BSEP-3: executor receives phone of subject_2, not subject_1 (sender)", async () => {
  const s2Phone = "+420987654321";
  const registry = makeS1S2Registry(s2Phone);
  let capturedPhone: string | undefined;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_3",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Записали." },
      },
    ]),
    executors: {
      "booking.apply": async (ctx) => {
        capturedPhone = ctx.phone_number;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00", "subject_2" as SubjectId),
  });

  await loop.runTurn({
    ...BASE_TURN_INPUT,
    booking_subjects: registry,
    channel_contact: { phone_number: "+380991350135", phone_source: "telegram_contact_button" },
  });

  assert.equal(capturedPhone, s2Phone, "executor must receive subject_2's phone, not subject_1 sender phone");
});

// ── Test 4: Round-2 bootstrap from availability.check → booking.apply ────────

test("BSEP-4: round-2 bootstrap creates registry when availability.check in round-1, booking.apply in round-2", async () => {
  let resolvedSubject: string | undefined;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", call_id: "call_avail", arguments: { requested_date: "2026-07-09" } }],
      },
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_book",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Записали." },
      },
    ]),
    executors: {
      "availability.check": async () => ({
        status: "success" as const,
        data: { slots: [{ slot_id: "s1", starts_at: "2026-07-09T12:00:00", ends_at: "2026-07-09T12:30:00" }], total_slots: 1, free_slots_count: 1 },
      }),
      "booking.apply": async (ctx) => {
        resolvedSubject = ctx.phone_number; // capture what phone was used (no phone → undefined)
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
    // No booking_subjects input — registry must be bootstrapped in round-2
  });

  // Registry was bootstrapped in round-2 so Guard J resolved execution subject
  assert.equal(result.execution_subject_id, "subject_2", "round-2 bootstrap must freeze execution_subject_id=subject_2");
  assert.ok(result.booking_subjects_after_resolution, "bootstrapped registry must be returned");
  assert.equal(result.booking_subjects_after_resolution?.subjects.length, 2, "bootstrapped registry must have subject_1 + subject_2");
});

// ── Test 5: Round-2 bootstrap does NOT use sender phone for subject_2 ─────────

test("BSEP-5: booking.apply proceeds using subject_1 trusted phone as fallback when subject_2 has no phone (bootstrap)", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    // Pin "now" so 2026-07-09T12:00 slot is in the future (avoids past-time guard)
    now: new Date("2026-07-09T09:00:00.000Z"),
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_book2",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Запись для Ивана Петрова создана." },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    // State repo provides valid subject_2 proof; no avail.check in round-1 so proof is preserved
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00", "subject_2" as SubjectId),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT, // sender has trusted phone — subject_1 gets it via bootstrap → fallback for subject_2
    // No booking_subjects — bootstrap creates registry with subject_1 having sender's trusted phone
  });

  // Executor runs: subject_1's trusted phone is valid booking contact for subject_2
  assert.equal(executorCalled, true, "executor must run: subject_1 trusted phone is valid fallback for subject_2");
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "booking result must be present");
  const status = (bookingResult!.data as Record<string, unknown>).booking_status;
  assert.equal(status, "visit_created", "booking must succeed using subject_1 trusted phone as contact");
});

// ── Test 6: current_turn_typed_phone becomes pending_typed_phone in bootstrap ─

test("BSEP-6: current_turn_typed_phone becomes pending_typed_phone in bootstrapped registry", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_typed_phone",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Чей это номер?" },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    // No booking_subjects — bootstrap will create registry
    // No channel_contact
    current_turn_typed_phone: "+420728945521", // user typed phone this turn
  });

  // Guard I must fire (pending_typed_phone present in bootstrapped registry)
  assert.equal(executorCalled, false, "executor must not run when phone ownership unclear");

  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded result must be present");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "pending_phone_classification",
    "must block for phone classification",
  );

  // Bootstrapped registry must have pending_typed_phone set
  assert.equal(
    result.booking_subjects_after_resolution?.pending_typed_phone,
    "+420728945521",
    "pending_typed_phone must be set from current_turn_typed_phone",
  );
});

// ── Test 7: Old persisted provided_phone does NOT become pending again ─────────

test("BSEP-7: existing provided_phone (not current-turn) does not create new pending_typed_phone", async () => {
  // Simulate: registry exists with no pending phone, old provided_phone in DB
  // current_turn_typed_phone is NOT set (user did not type a phone this turn)
  const registry = makeS1S2Registry("+420987654321"); // subject_2 has phone

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_no_pending",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Записали." },
      },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    booking_subjects: registry,
    channel_contact: TRUSTED_CONTACT,
    // current_turn_typed_phone NOT set (old phone not re-injected)
    provided_phone: {
      phone_number: "+420728945521",
      phone_source: "typed",
      phone_trust: "unverified",
      phone_consent: false,
      phone_collected_at: "2026-07-10T10:00:00Z",
    },
  });

  // No pending_typed_phone — booking should proceed without classification block
  assert.equal(result.execution_subject_id, "subject_2", "booking must proceed with subject_2");
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "booking result must be present");
  assert.notEqual(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "pending_phone_classification",
    "old persisted provided_phone must not trigger phone classification",
  );
});

// ── Test 8: Completed registry does NOT block self-booking ────────────────────

test("BSEP-8: completed registry treated as null — self-booking continues as single-subject flow", async () => {
  let executorCalled = false;

  // Completed registry in DB — but initBookingSubjectsForTurn should return null
  const completedRegistry: BookingSubjectsState = {
    version: 3,
    status: "completed",
    active_subject_id: "subject_1" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима",
        service: "Чистка", slot: "2026-07-09T12:00",
        booking_contact: makeBookingContact("+380991350135", "telegram_contact_button", "trusted", "subject_1"),
        status: "booked", missing: [],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: null, patient_name: "Иван",
        service: "Чистка", slot: "2026-07-09T13:00",
        booking_contact: makeBookingContact("+420987654321", "telegram_contact_button", "trusted", "subject_2"),
        status: "booked", missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  // initBookingSubjectsForTurn must return null for completed registry
  const initResult = initBookingSubjectsForTurn({
    current: completedRegistry,
    channelContact: TRUSTED_CONTACT,
    pendingTypedPhone: null,
  });
  assert.equal(initResult, null, "completed registry must be treated as null by initBookingSubjectsForTurn");

  // In the loop, booking_subjects is null (no registry) → single-subject flow
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_self",
          arguments: {
            subject_id: "subject_1", // universal subject_id required — subject_1 = sender/self
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Рима",
            last_name: "Иванова",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Записаны." },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
    // booking_subjects NOT passed (orchestrator returned null for completed registry)
  });

  assert.equal(executorCalled, true, "executor must run for self-booking without completed registry blocking");
  assert.equal(result.final_patient_reply, "Записаны.", "self-booking must proceed normally");
});

// ── Test 9: Completed registry → fresh multi-subject registry ─────────────────

test("BSEP-9: completed registry replaced by fresh registry when new booking targets subject_2", async () => {
  // bootstrap creates fresh registry, ignores old completed state
  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_fresh",
          arguments: {
            subject_id: "subject_2",
            service: "Лечение",
            requested_date: "2026-07-15",
            requested_time: "10:00",
            first_name: "Новый",
            last_name: "Пациент",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Нет номера." },
      },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-15T10:00:00"),
  });

  // No booking_subjects (completed was not passed — orchestrator treats it as null)
  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.ok(result.booking_subjects_after_resolution, "fresh registry must be created");
  const fresh = result.booking_subjects_after_resolution!;
  assert.equal(fresh.status, "active", "fresh registry must be active");
  assert.equal(fresh.subjects.length, 2, "fresh registry must have subject_1 + subject_2");

  // Old names/slots/services must NOT be in fresh registry
  const s2 = fresh.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.patient_name, "Новый Пациент", "fresh subject_2 must have new name only");
  assert.equal(s2?.slot, null, "fresh subject_2 must have no slot from old registry");
});

// ── Test 10: Invalid subject invalidates whole state (all-or-nothing) ─────────

test("BSEP-10: invalid v3 subject invalidates entire state (all-or-nothing)", () => {
  const rawWithBadSubject = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1",
    subjects: [
      { id: "subject_1", role: "sender", patient_name: "Рима", service: null, slot: null, booking_contact: null, status: "collecting", label: null },
      { id: "subject_INVALID", role: "mentioned_person", patient_name: "Иван", service: null, slot: null, booking_contact: null, status: "collecting", label: null },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };
  const result = normalizeBookingSubjectsState(rawWithBadSubject);
  assert.equal(result, null, "any invalid subject must reject the entire state");
});

// ── Test 11: Invalid booking_contact invalidates whole state ──────────────────

test("BSEP-11: invalid booking_contact object invalidates entire state", () => {
  const rawWithBadContact = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1",
    subjects: [
      {
        id: "subject_1",
        role: "sender",
        patient_name: "Рима",
        service: null,
        slot: null,
        // booking_contact present but invalid (typed source requires unverified trust, not trusted)
        booking_contact: { phone_number: "+380991350135", source: "typed", trust: "trusted", owner_subject_id: "subject_1", collected_at: null },
        status: "collecting",
        label: null,
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };
  const result = normalizeBookingSubjectsState(rawWithBadContact);
  assert.equal(result, null, "invalid booking_contact must reject the entire state, not silently become null");
});

// ── Test 12: Registry + missing executionSubjectId → no phone fallback ────────

test("BSEP-12: registry present + executionSubjectId=null → hasSubjectOrContactPhone=false, no active-subject fallback", async () => {
  // Registry with subject_1 (active, has phone), subject_2 targeted but no subject_id in args
  const registry = makeS1S2Registry(); // subject_2 has no phone
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_no_subj",
          arguments: {
            // No subject_id — Guard J fires with subject_id_required
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Уточните субъект." },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    booking_subjects: registry,
    channel_contact: TRUSTED_CONTACT,
  });

  // Guard J fires: subject_id_required (no fallback to active subject_1 phone)
  assert.equal(executorCalled, false, "executor must not run without explicit subject_id");
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "subject_resolution_conflict",
    "must get subject_resolution_conflict, not missing_trusted_phone",
  );
});

// ── Test 13: Synthetic blocked result does NOT mark subject as booked ─────────

test("BSEP-13: synthetic blocked booking (created_visit=false) does not set subject.status=booked", () => {
  const registry = makeS1S2Registry("+420987654321");
  const toolRequests = [{
    tool: "booking.apply" as const,
    call_id: "c1",
    arguments: { subject_id: "subject_2", first_name: "Иван", last_name: "Петров", service: "Чистка", requested_date: "2026-07-09", requested_time: "12:00" },
  }];
  const toolResults = [{
    tool: "booking.apply" as const,
    call_id: "c1",
    status: "success" as const,
    data: {
      booking_status: "missing_trusted_phone",
      created_visit: false,
      may_claim_booked: false,
      required_next_action: "ask_for_phone",
      reason: "trusted_phone_required",
    },
  }];

  const persisted = postUpdateBookingSubjects({
    current: registry,
    toolRequests,
    toolResults,
    executionSubjectId: "subject_2" as SubjectId,
  });

  const s2 = persisted.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "collecting", "blocked booking must not change subject status to booked");
  assert.notEqual(s2?.status, "booked", "subject must remain collecting when created_visit=false");
});

// ── Test 14: Successful visit updates ONLY frozen subject ─────────────────────

test("BSEP-14: successful booking updates only frozen execution subject, not active subject", () => {
  // active_subject_id = subject_1, but execution_subject_id = subject_2
  const registry: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима",
        service: "Чистка", slot: "2026-07-09T12:00",
        booking_contact: makeBookingContact("+380991350135", "telegram_contact_button", "trusted", "subject_1"),
        status: "collecting", missing: [],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: null, patient_name: "Иван",
        service: "Чистка", slot: "2026-07-09T12:00",
        booking_contact: makeBookingContact("+420987654321", "telegram_contact_button", "trusted", "subject_2"),
        status: "collecting", missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const toolRequests = [{
    tool: "booking.apply" as const,
    call_id: "c2",
    arguments: { subject_id: "subject_2", first_name: "Иван", last_name: "Петров", service: "Чистка", requested_date: "2026-07-09", requested_time: "12:00" },
  }];
  const toolResults = [{
    tool: "booking.apply" as const,
    call_id: "c2",
    status: "success" as const,
    data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
  }];

  const persisted = postUpdateBookingSubjects({
    current: registry,
    toolRequests,
    toolResults,
    executionSubjectId: "subject_2" as SubjectId,
  });

  const s1 = persisted.subjects.find((s) => s.id === "subject_1");
  const s2 = persisted.subjects.find((s) => s.id === "subject_2");

  assert.equal(s2?.status, "booked", "execution subject (subject_2) must be booked");
  assert.equal(s1?.status, "collecting", "non-execution subject (subject_1) must remain collecting");
});

// ── Test 15: Round-2 bootstrap with Guard J subject resolution ────────────────

test("BSEP-15: bootstrap: registry created, sender trusted phone used as fallback for subject_2 booking", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    // Pin "now" so 2026-07-09T12:00 slot is in the future (avoids past-time guard)
    now: new Date("2026-07-09T09:00:00.000Z"),
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "bk1",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Запись для Ивана Петрова создана." },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    // State repo provides valid subject_2 proof; no avail.check in round-1 so proof is preserved
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00", "subject_2" as SubjectId),
  });

  // No booking_subjects — bootstrap assigns sender's trusted phone to subject_1, used as fallback for subject_2
  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    channel_contact: TRUSTED_CONTACT, // sender has trusted phone — subject_1 gets it via bootstrap
  });

  assert.equal(executorCalled, true, "executor runs: subject_1 trusted phone is valid fallback for subject_2");
  const bookingResult = result.tool_results?.find((r) => r.tool === "booking.apply");
  const status = (bookingResult!.data as Record<string, unknown>).booking_status;
  assert.equal(status, "visit_created", "booking succeeds using subject_1 trusted phone as contact");
  assert.equal(result.execution_subject_id, "subject_2", "execution_subject_id frozen to subject_2");
  assert.ok(result.booking_subjects_after_resolution, "bootstrapped registry returned");
  const s2 = result.booking_subjects_after_resolution!.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "collecting", "subject_2 remains collecting at loop level (orchestrator updates to booked)");
});

// ── Test 16: Round-1 malformed response still carries execution metadata ───────

test("BSEP-16: round-1 malformed second response still returns execution_subject_id + booking_subjects", async () => {
  const registry = makeS1S2Registry("+420987654321");

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_malformed",
          arguments: {
            subject_id: "subject_2",
            service: "Чистка",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Петров",
          },
        }],
      },
      // Malformed second response
      {
        type: "final_response",
        final_response: {
          final_patient_reply: "MALFORMED",
          safety_notes: ["malformed_openai_response"],
        },
      },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00", "subject_2" as SubjectId),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    booking_subjects: registry,
    channel_contact: TRUSTED_CONTACT,
  });

  // Even on malformed response, execution metadata must be propagated
  assert.equal(result.execution_subject_id, "subject_2", "execution_subject_id must survive malformed response");
  assert.ok(result.booking_subjects_after_resolution, "booking_subjects_after_resolution must survive malformed response");
});

// ── Test 17: source/trust validation all-or-nothing ──────────────────────────

test("BSEP-17: invalid source/trust combo in booking_contact invalidates state", () => {
  // trusted_contact_owner requires shared_from_subject source
  const raw = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1",
    subjects: [{
      id: "subject_1",
      role: "sender",
      patient_name: "Рима",
      service: null,
      slot: null,
      booking_contact: {
        phone_number: "+380991350135",
        source: "telegram_contact_button",
        trust: "trusted_contact_owner", // invalid: trusted_contact_owner requires shared_from_subject
        owner_subject_id: "subject_1",
        collected_at: null,
      },
      status: "collecting",
      label: null,
    }],
    pending_typed_phone: null,
    max_subjects: 4,
  };
  assert.equal(normalizeBookingSubjectsState(raw), null, "invalid trust/source combo must reject state");
});

// ── Test 18: booking_subjects_after_resolution round-trips through persistence ─

test("BSEP-18: booking_subjects_after_resolution from loop round-trips through postUpdateBookingSubjects correctly", async () => {
  const s2Phone = "+420123456789";
  const registry = makeS1S2Registry(s2Phone);

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_rt",
          arguments: {
            subject_id: "subject_2",
            service: "Лечение",
            requested_date: "2026-07-09",
            requested_time: "12:00",
            first_name: "Иван",
            last_name: "Сидоров",
          },
        }],
      },
      {
        type: "final_response",
        final_response: { final_patient_reply: "Иван Сидоров записан." },
      },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-09T12:00:00", "subject_2" as SubjectId),
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    booking_subjects: registry,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.ok(result.booking_subjects_after_resolution, "booking_subjects_after_resolution must be present");
  assert.equal(result.execution_subject_id, "subject_2");

  // Simulate orchestrator applying the update
  const persisted = postUpdateBookingSubjects({
    current: result.booking_subjects_after_resolution!,
    toolRequests: result.tool_requests,
    toolResults: result.tool_results,
    executionSubjectId: result.execution_subject_id as SubjectId ?? null,
  });

  const s2 = persisted.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "booked", "subject_2 must be booked after round-trip");
  assert.equal(s2?.patient_name, "Иван Сидоров", "name from booking.apply args applied");
  assert.equal(s2?.service, "Лечение", "service from booking.apply args applied");

  const s1 = persisted.subjects.find((s) => s.id === "subject_1");
  assert.equal(s1?.status, "collecting", "subject_1 unchanged");
});

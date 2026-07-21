/**
 * Subject v3 tool contract tests — Points 8 & 9.
 *
 * TC-1  booking.apply without subject_id always blocked (no registry)
 * TC-2  subject_id=subject_1, no registry → single-subject phone
 * TC-3  subject_id=subject_2, no registry → registry bootstrapped
 * TC-4  No subject_id → executor never goes to ClinicCard
 * TC-5  RU / CS / EN same request → same guard target
 * TC-6  subject_intent bootstrap saves current typed phone as pending_typed_phone
 * TC-7  same-response phone_ownership_intent assign_pending_phone resolves
 * TC-8  completed registry + stale typed provided_phone → stale not used
 * TC-9  forced finalization path preserves execution_subject_id
 * TC-10 guarded exception path preserves bootstrap state (booking_subjects_after_resolution)
 * TC-11 primitive booking_contact string → normalizeBookingSubjectsState returns null
 * TC-12 shared phone must equal owner phone → validateFullBookingContact returns null
 * TC-13 isEffectiveTrustedContact prevents overwriting trusted/trusted_contact_owner contacts
 *
 * OC-1  2-turn orchestrator persistence: turn-1 saves registry, turn-2 reloads it
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type { RuntimeAgentCallerOutput } from "../src/runtime/runtimeAgentLoop.ts";
import {
  normalizeBookingSubjectsState,
  postUpdateBookingSubjects,
  isEffectiveTrustedContact,
  applyPhoneOwnershipIntent,
  bootstrapBookingSubjectsFromIntent,
} from "../src/runtime/bookingSubjectsState.ts";
import type {
  BookingSubjectsState,
  SubjectId,
  BookingContact,
  PhoneOwnershipIntent,
} from "../src/runtime/bookingSubjectsState.ts";
import type { ChannelContact } from "../src/runtime/openaiRuntimeAgent.ts";
import { runRuntimeTurnOrchestrated } from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { RuntimeTurnOrchestratorDeps } from "../src/runtime/runtimeTurnOrchestrator.ts";
import type { RuntimeContextRepository } from "../src/runtime/supabaseRuntimeContextRepository.ts";
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";
import type { RuntimeTurnService, RuntimeTurnResult } from "../src/runtime/runtimeTurnService.ts";
import { createRuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSlotStateRepo(starts_at: string) {
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
        selected_slot_proof: { availability_call_id: callId, slot_key: slotKey },
      };
    },
    async saveState() {},
  };
}

function makeCallerSequence(outputs: RuntimeAgentCallerOutput[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

const BASE_TURN = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  user_message: "хочу записаться",
  locale: "ru" as const,
  trace_id: "trace_tc",
};

// ── TC-1: booking.apply without subject_id blocked even without registry ───────

test("TC-1: booking.apply without subject_id always blocked (no registry present)", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_tc1",
          arguments: {
            // subject_id deliberately absent
            first_name: "Иван",
            last_name: "Петров",
            service: "чистка",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Пожалуйста, уточните от чьего имени." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(executorCalled, false, "executor must not be called when subject_id is absent");
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded result must appear");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "subject_resolution_conflict",
    "status must be subject_resolution_conflict",
  );
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).reason,
    "subject_id_required",
    "reason must be subject_id_required",
  );
});

// ── TC-2: subject_id=subject_1, no registry → single-subject phone ─────────

test("TC-2: subject_id=subject_1, no registry → executor uses channel_contact phone", async () => {
  let capturedPhone: string | undefined;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_tc2",
          arguments: {
            subject_id: "subject_1",
            first_name: "Іван",
            last_name: "Петров",
            service: "чистка",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Записано!" } },
    ]),
    executors: {
      "booking.apply": async (ctx) => {
        capturedPhone = ctx.phone_number;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(capturedPhone, TRUSTED_CONTACT.phone_number, "executor receives channel_contact phone for self-booking");
  assert.equal(result.execution_subject_id, "subject_1", "single-subject flow must freeze execution_subject_id to subject_1 per universal contract");
});

// ── TC-3: subject_id=subject_2, no registry → registry bootstrapped ──────────

test("TC-3: subject_id=subject_2, no registry → registry bootstrapped via bootstrapRegistryFromBookingApplyArgs", async () => {
  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_tc3",
          arguments: {
            subject_id: "subject_2",
            first_name: "Анна",
            last_name: "Козлова",
            service: "осмотр",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Анна записана." } },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(result.execution_subject_id, "subject_2", "execution_subject_id must be subject_2");
  assert.ok(result.booking_subjects_after_resolution, "booking_subjects_after_resolution must be present");
  const subjects = result.booking_subjects_after_resolution!.subjects;
  assert.ok(subjects.find((s) => s.id === "subject_2"), "registry must have subject_2");
  assert.ok(subjects.find((s) => s.id === "subject_1"), "registry must have subject_1 (sender)");
});

// ── TC-4: No subject_id → executor NEVER called (ClinicCard safe) ─────────────

test("TC-4: no subject_id → executor never called regardless of phone/slot presence", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_tc4",
          arguments: {
            // No subject_id
            first_name: "Тест",
            last_name: "Пациент",
            service: "чистка",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Нужен subject_id." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(executorCalled, false, "ClinicCard executor must NEVER be called when subject_id absent");
});

// ── TC-5: RU / CS / EN same request → same guard result ────────────────────────

test("TC-5: same request in RU, CS, EN all hit subject_resolution_conflict when subject_id absent", async () => {
  async function runWithLocale(locale: "ru" | "cs" | "en") {
    const loop = createRuntimeAgentLoop({
      now: new Date("2027-08-15T07:00:00Z"),
      model: "test-model",
      caller: makeCallerSequence([
        {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: `call_tc5_${locale}`,
            arguments: {
              // No subject_id — triggers Guard J
              first_name: "Test",
              last_name: "User",
              service: "cleaning",
              requested_date: "2027-08-15",
              requested_time: "11:00",
            },
          }],
        },
        { type: "final_response", final_response: { final_patient_reply: "OK" } },
      ]),
      executors: {},
      bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
    });

    return loop.runTurn({
      ...BASE_TURN,
      locale,
      channel_contact: TRUSTED_CONTACT,
    });
  }

  const [ru, cs, en] = await Promise.all([runWithLocale("ru"), runWithLocale("cs"), runWithLocale("en")]);

  for (const [locale, result] of [["ru", ru], ["cs", cs], ["en", en]] as const) {
    const br = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(br, `${locale}: guarded result must appear`);
    assert.equal(
      (br!.data as Record<string, unknown>).booking_status,
      "subject_resolution_conflict",
      `${locale}: must be subject_resolution_conflict`,
    );
    assert.equal(
      (br!.data as Record<string, unknown>).reason,
      "subject_id_required",
      `${locale}: reason must be subject_id_required`,
    );
  }
});

// ── TC-6: subject_intent propagated by loop, orchestrator bootstraps with typed phone ──

test("TC-6: subject_intent in final_response → loop propagates it; bootstrapBookingSubjectsFromIntent honors pendingTypedPhone", () => {
  // The loop propagates subject_intent; the orchestrator calls bootstrapBookingSubjectsFromIntent.
  // This test verifies the bootstrap function itself receives and saves the typed phone.
  const TYPED_PHONE = "+420728123456";

  const intent = {
    action: "create_subjects" as const,
    target: "mentioned_person" as const,
    count: 1,
    labels: ["мама"],
    confidence: "high" as const,
  };
  const channelContact: ChannelContact = {
    phone_number: "+380991350135",
    phone_source: "telegram_contact_button",
  };

  const registry = bootstrapBookingSubjectsFromIntent(intent, null, channelContact, TYPED_PHONE);

  assert.ok(registry, "bootstrapBookingSubjectsFromIntent must create registry");
  assert.equal(registry!.pending_typed_phone, TYPED_PHONE, "pending_typed_phone must equal typed phone passed in");
  assert.ok(registry!.subjects.find((s) => s.id === "subject_2"), "registry must include subject_2");
});

// ── TC-7: same-response phone_ownership_intent assign_pending_phone resolves ──

test("TC-7: phone_ownership_intent assign_pending_phone → applyPhoneOwnershipIntent assigns pending phone to active subject", () => {
  // The loop propagates phone_ownership_intent; the orchestrator calls postUpdateBookingSubjects
  // which calls applyPhoneOwnershipIntent. This test directly verifies the assignment logic.
  const PENDING_PHONE = "+420123456789";

  const state: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима", service: null,
        slot: null, booking_contact: { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_1" as SubjectId, collected_at: null },
        status: "collecting", missing: ["service", "slot"],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: null, service: "чистка",
        slot: null, booking_contact: null, status: "collecting", missing: ["patient_name", "slot", "booking_contact"],
      },
    ],
    pending_typed_phone: PENDING_PHONE,
    max_subjects: 4,
  };

  const intent: PhoneOwnershipIntent = {
    action: "assign_pending_phone",
    target_subject_id: "subject_2" as SubjectId,
    confidence: "high",
  };

  const after = applyPhoneOwnershipIntent(state, intent);
  const s2 = after.subjects.find((s) => s.id === "subject_2");
  assert.ok(s2?.booking_contact, "subject_2 must have booking_contact after assignment");
  assert.equal(s2!.booking_contact!.phone_number, PENDING_PHONE, "assigned phone must match pending_typed_phone");
  assert.equal(after.pending_typed_phone, null, "pending_typed_phone must be cleared after assignment");
});

// ── TC-8: completed registry + stale typed provided_phone → stale not used ───

test("TC-8: had_booking_subjects suppresses stale typed provided_phone in self-booking", async () => {
  let capturedPhone: string | undefined;

  // Stale phone (typed by user in a PREVIOUS turn about a third-party booking)
  const STALE_TYPED_PHONE = "+420999888777";

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_tc8",
          arguments: {
            subject_id: "subject_1",
            first_name: "Рима",
            last_name: "Шевченко",
            service: "осмотр",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Рима записана." } },
    ]),
    executors: {
      "booking.apply": async (ctx) => {
        capturedPhone = ctx.phone_number;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
    provided_phone: {
      phone_number: STALE_TYPED_PHONE,
      phone_source: "typed",
      phone_trust: "unverified",
      phone_consent: false,
      phone_collected_at: "2026-07-01T10:00:00.000Z",
    },
    had_booking_subjects: true, // signals stale phone suppression
  });

  assert.equal(capturedPhone, TRUSTED_CONTACT.phone_number,
    "stale typed provided_phone must be suppressed; executor receives channel_contact phone");
  assert.notEqual(capturedPhone, STALE_TYPED_PHONE, "stale typed phone must not reach executor");
});

// ── TC-9: forced finalization preserves execution_subject_id ──────────────────

test("TC-9: booking.apply in round-1 then kb.search round-2 → forced finalization still has execution_subject_id", async () => {
  const REGISTRY: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима", service: null,
        slot: null, booking_contact: { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_1" as SubjectId, collected_at: null },
        status: "collecting", missing: ["service", "slot"],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: null, patient_name: "Иван", service: "чистка",
        slot: "2027-08-15T11:00", booking_contact: { phone_number: "+420123456789", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      // Round 1: booking.apply for subject_2
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "call_tc9",
          arguments: {
            subject_id: "subject_2",
            first_name: "Иван",
            last_name: "Петров",
            service: "чистка",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      // Round 2: kb.search (triggers multi_round_tool_loop_not_implemented)
      {
        type: "tool_requests",
        tool_requests: [{ tool: "kb.search", call_id: "ks_tc9", arguments: { query: "test" } }],
      },
      // Forced finalization
      { type: "final_response", final_response: { final_patient_reply: "Иван записан." } },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
      "kb.search": async () => ({ status: "success" as const, data: { chunks: [] } }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    booking_subjects: REGISTRY,
    channel_contact: TRUSTED_CONTACT,
  });

  // Execution subject must be preserved even through multi-round path
  assert.equal(result.execution_subject_id, "subject_2",
    "execution_subject_id must be subject_2 even after multi-round tool loop path");
  assert.ok(result.booking_subjects_after_resolution,
    "booking_subjects_after_resolution must be present in multi-round path");
});

// ── TC-10: guarded exception path preserves bootstrap state ──────────────────

test("TC-10: guarded exception after subject_2 bootstrap → booking_subjects_after_resolution preserved", async () => {
  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: async (input) => {
      const callNum = (input.input.tool_results ?? []).length;
      if (callNum === 0) {
        // Round 1: booking.apply for subject_2 (no registry → bootstrapped)
        return {
          type: "tool_requests",
          tool_requests: [{
            tool: "booking.apply",
            call_id: "call_tc10",
            arguments: {
              subject_id: "subject_2",
              first_name: "Анна",
              last_name: "Козлова",
              service: "осмотр",
              requested_date: "2027-08-15",
              requested_time: "11:00",
            },
          }],
        } as RuntimeAgentCallerOutput;
      }
      // Round 2: throw exception (caller fails)
      throw new Error("model_exception_tc10");
    },
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
  });

  // Despite exception, the bootstrap state must survive
  assert.ok(result.booking_subjects_after_resolution,
    "booking_subjects_after_resolution must be preserved even when second caller throws");
  assert.ok(result.booking_subjects_after_resolution!.subjects.find((s) => s.id === "subject_2"),
    "bootstrapped registry must include subject_2");
});

// ── TC-11: primitive booking_contact → normalized to null (invalid contact ignored) ──

test("TC-11: primitive booking_contact (string) → normalizeBookingSubjectsState nullifies it (invalid contact)", () => {
  const raw = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1",
    subjects: [
      {
        id: "subject_1",
        role: "sender",
        label: null,
        patient_name: "Тест",
        service: null,
        slot: null,
        booking_contact: "+380991350135", // primitive, not a valid BookingContact object
        status: "collecting",
        missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const result = normalizeBookingSubjectsState(raw);
  assert.equal(result, null, "primitive booking_contact (string) must make the whole state invalid → null");
});

// ── TC-12: shared phone must equal owner phone ────────────────────────────────

test("TC-12: shared_from_subject contact with phone ≠ owner phone → state normalized as invalid (booking_contact null)", () => {
  // Build a state where subject_2's shared contact phone does NOT match subject_1's phone
  const raw = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2",
    subjects: [
      {
        id: "subject_1",
        role: "sender",
        label: null,
        patient_name: null,
        service: null,
        slot: null,
        booking_contact: {
          phone_number: "+380991350135", // owner's real phone
          source: "telegram_contact_button",
          trust: "trusted",
          owner_subject_id: "subject_1",
          collected_at: null,
        },
        status: "collecting",
        missing: [],
      },
      {
        id: "subject_2",
        role: "mentioned_person",
        label: null,
        patient_name: null,
        service: null,
        slot: null,
        booking_contact: {
          phone_number: "+420999000111", // DIFFERENT phone (mismatch!)
          source: "shared_from_subject",
          trust: "trusted_contact_owner",
          owner_subject_id: "subject_1",
          collected_at: null,
        },
        status: "collecting",
        missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const result = normalizeBookingSubjectsState(raw);
  assert.equal(result, null, "shared booking_contact with mismatched phone must make the whole state invalid → null");
});

// ── TC-13: isEffectiveTrustedContact prevents overwriting trusted contacts ────

test("TC-13: isEffectiveTrustedContact — trusted and trusted_contact_owner both return true", () => {
  const trustedContact: BookingContact = {
    phone_number: "+380991350135",
    source: "telegram_contact_button",
    trust: "trusted",
    owner_subject_id: "subject_1" as SubjectId,
    collected_at: null,
  };
  const trustedOwnerContact: BookingContact = {
    phone_number: "+380991350135",
    source: "shared_from_subject",
    trust: "trusted_contact_owner",
    owner_subject_id: "subject_1" as SubjectId,
    collected_at: null,
  };
  const unverifiedContact: BookingContact = {
    phone_number: "+420123456789",
    source: "typed",
    trust: "unverified",
    owner_subject_id: "subject_2" as SubjectId,
    collected_at: null,
  };

  assert.equal(isEffectiveTrustedContact(trustedContact), true, "trusted → true");
  assert.equal(isEffectiveTrustedContact(trustedOwnerContact), true, "trusted_contact_owner → true");
  assert.equal(isEffectiveTrustedContact(unverifiedContact), false, "unverified → false");
  assert.equal(isEffectiveTrustedContact(null), false, "null → false");
  assert.equal(isEffectiveTrustedContact(undefined), false, "undefined → false");
});

test("TC-13b: applyPhoneOwnershipIntent.assign_pending_phone does NOT overwrite trusted contact", () => {
  const state: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: null, service: null,
        slot: null, booking_contact: null, status: "collecting", missing: [],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: null, patient_name: null, service: null,
        slot: null,
        booking_contact: {
          phone_number: "+380991350135",
          source: "telegram_contact_button",
          trust: "trusted",
          owner_subject_id: "subject_2" as SubjectId,
          collected_at: null,
        },
        status: "collecting", missing: [],
      },
    ],
    pending_typed_phone: "+420999000111",
    max_subjects: 4,
  };

  const intent: PhoneOwnershipIntent = {
    action: "assign_pending_phone",
    target_subject_id: "subject_2" as SubjectId,
    confidence: "high",
  };

  const after = applyPhoneOwnershipIntent(state, intent);
  const s2 = after.subjects.find((s) => s.id === "subject_2");
  assert.equal(
    s2!.booking_contact!.phone_number,
    "+380991350135",
    "trusted contact must NOT be overwritten by assign_pending_phone",
  );
  assert.equal(
    s2!.booking_contact!.trust,
    "trusted",
    "trust level must remain trusted after blocked assignment attempt",
  );
});

// ── OC-1: 2-turn orchestrator persistence ────────────────────────────────────

const CLINIC_CODE_OC = "clinic_oc1";
const CLINIC_UUID_OC = "11111111-2222-4333-8444-555555555555";
const CONTACT_UUID_OC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("OC-1: 2-turn orchestrator persistence — turn-1 bootstraps registry, turn-2 reloads with had_booking_subjects=true", async () => {
  // State store — captures what mergeConversationState saves
  let savedBookingSubjects: BookingSubjectsState | null = null;
  let turn2CapturedInput: Parameters<RuntimeTurnService["runTurn"]>[0] | null = null;

  const stubClinicResolver: ClinicIdentityResolver = {
    async resolveClinicIdentity(input) {
      if (input.clinic_identifier === CLINIC_CODE_OC) {
        return { ok: true, data: { clinic_id: CLINIC_UUID_OC, clinic_code: CLINIC_CODE_OC } };
      }
      return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
    },
  };

  const stubPersistence: TurnPersistenceRepository = {
    async getOrCreateContact() {
      return { ok: true, data: { contact_id: CONTACT_UUID_OC, clinic_id: CLINIC_UUID_OC } };
    },
    async registerInboundEvent() {
      return { ok: true, data: { inbound_event_id: "evt_oc1" } };
    },
    async saveMessage() {
      return { ok: true, data: { message_id: "msg_oc1" } };
    },
    async mergeConversationState(input) {
      // Capture booking_subjects saved by turn 1
      if (input.control_flags?.booking_subjects) {
        savedBookingSubjects = input.control_flags.booking_subjects as BookingSubjectsState;
      }
      return { ok: true, data: { ok: true } };
    },
  };

  // Stateful context repo — returns saved subjects on turn 2
  const makeContextRepo = (): RuntimeContextRepository => ({
    async loadRuntimeContext() {
      return {
        ok: true,
        data: {
          known_contact: {},
          conversation_state: {},
          topic_memory: null,
          channel_contact: {
            phone_number: "+380991350135",
            phone_source: "telegram_contact_button" as const,
            phone_consent: true,
            phone_collected_at: "2026-07-01T00:00:00.000Z",
          },
          provided_phone: null,
          booking_subjects: savedBookingSubjects, // null for turn 1, populated for turn 2
          selected_slot_starts_at: null,
          case_context_lite: null,
          runtime_flags: {
            has_durable_context: true,
            context_source: "supabase" as const,
            context_loaded_at: new Date().toISOString(),
          },
          recent_history: [],
        },
      };
    },
  });

  // ── Turn 1: model returns subject_intent → bootstrap registry ───────────────

  let turnServiceCallCount = 0;
  const contextRepo = makeContextRepo();

  const turn1Service: RuntimeTurnService = {
    async runTurn(_input) {
      turnServiceCallCount++;
      // Simulate model returning subject_intent to bootstrap a registry
      const result: RuntimeTurnResult = {
        final_patient_reply: "Хорошо, записываю маму.",
        conversation_id: "conv_oc1_t1",
        tool_requests: [],
        tool_results: [],
        subject_intent: {
          action: "create_subjects",
          target: "mentioned_person",
          count: 1,
          labels: ["мама"],
          confidence: "high",
        },
      };
      return result;
    },
  };

  const deps1: RuntimeTurnOrchestratorDeps = {
    runtimeTurnService: turn1Service,
    clinicIdentityResolver: stubClinicResolver,
    turnPersistenceRepository: stubPersistence,
    runtimeContextRepository: contextRepo,
  };

  const body1 = {
    clinic_code: CLINIC_CODE_OC,
    channel: "telegram" as const,
    external_user_id: "user_oc1",
    chat_id: "777",
    text: "Запишите мою маму",
    meta: {
      update_id: 1001,
      message_id: 201,
      username: null,
      first_name: null,
      last_name: null,
      telegram_chat_type: "private" as const,
    },
  };

  const result1 = await runRuntimeTurnOrchestrated(body1, deps1);
  assert.ok(result1.outcome === "success" || result1.outcome === "error", `turn 1 outcome: ${result1.outcome}`);
  assert.ok(savedBookingSubjects !== null, "turn 1 must persist booking_subjects via mergeConversationState");

  // Verify bootstrapped registry has subject_2 (from subject_intent → mentioned_person)
  const registry = savedBookingSubjects!;
  assert.ok(registry.subjects.length >= 2, "bootstrapped registry must have at least 2 subjects");
  const savedS2 = registry.subjects.find((s) => s.id === "subject_2");
  assert.ok(savedS2, "registry must have subject_2 created for 'мама'");

  // ── Turn 2: context repo now returns saved subjects ─────────────────────────

  const turn2Service: RuntimeTurnService = {
    async runTurn(input) {
      turnServiceCallCount++;
      turn2CapturedInput = input;
      return {
        final_patient_reply: "Мама записана!",
        conversation_id: "conv_oc1_t2",
        tool_requests: [],
        tool_results: [],
      };
    },
  };

  const deps2: RuntimeTurnOrchestratorDeps = {
    runtimeTurnService: turn2Service,
    clinicIdentityResolver: stubClinicResolver,
    turnPersistenceRepository: stubPersistence,
    runtimeContextRepository: contextRepo, // same stateful repo
  };

  const body2 = {
    clinic_code: CLINIC_CODE_OC,
    channel: "telegram" as const,
    external_user_id: "user_oc1",
    chat_id: "777",
    text: "Маму зовут Анна Козлова",
    meta: {
      update_id: 1002,
      message_id: 202,
      username: null,
      first_name: null,
      last_name: null,
      telegram_chat_type: "private" as const,
    },
  };

  const result2 = await runRuntimeTurnOrchestrated(body2, deps2);
  assert.ok(result2.outcome === "success" || result2.outcome === "error", `turn 2 outcome: ${result2.outcome}`);
  assert.ok(turn2CapturedInput !== null, "turn 2 runtimeTurnService must have been called");

  // Verify turn 2 received the booking_subjects from turn 1
  const turn2Input = turn2CapturedInput!;
  assert.ok(turn2Input.booking_subjects !== null && turn2Input.booking_subjects !== undefined,
    "turn 2 must receive booking_subjects from turn 1 persistence");

  // Verify had_booking_subjects is set (signals stale phone suppression)
  assert.equal(
    turn2Input.had_booking_subjects,
    true,
    "turn 2 must have had_booking_subjects=true because subjects were persisted in turn 1",
  );

  assert.equal(turnServiceCallCount, 2, "runtimeTurnService.runTurn must have been called exactly twice (once per turn)");
});

// ── Point 3: Multiple booking.apply guard ──────────────────────────────────────

test("P3-1: two booking.apply in round-1 with subject_1 and subject_2 → executor called 0 times, multiple_booking_apply_requests", async () => {
  let executorCallCount = 0;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [
          {
            tool: "booking.apply",
            call_id: "ba_s1_p3",
            arguments: {
              subject_id: "subject_1",
              first_name: "Рима",
              last_name: "Шевченко",
              service: "чистка",
              requested_date: "2027-08-15",
              requested_time: "11:00",
            },
          },
          {
            tool: "booking.apply",
            call_id: "ba_s2_p3",
            arguments: {
              subject_id: "subject_2",
              first_name: "Анна",
              last_name: "Козлова",
              service: "осмотр",
              requested_date: "2027-08-15",
              requested_time: "11:00",
            },
          },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Уточните запись по одному." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCallCount, 0, "executor must never be called when multiple booking.apply in round-1");
  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded result must appear");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).reason,
    "multiple_booking_apply_requests",
    "reason must be multiple_booking_apply_requests",
  );
  assert.equal((bookingResult!.data as Record<string, unknown>).created_visit, false);
});

test("P3-2: round-1 booking.apply subject_1 executed → round-2 model requests booking.apply subject_2 → second not called, first result preserved", async () => {
  let executorCallCount = 0;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_r1_p3b",
          arguments: {
            subject_id: "subject_1",
            first_name: "Рима",
            last_name: "Шевченко",
            service: "чистка",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_r2_p3b",
          arguments: {
            subject_id: "subject_2",
            first_name: "Анна",
            last_name: "Козлова",
            service: "осмотр",
            requested_date: "2027-08-15",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Вы записаны. Вторую запись оформим следующим сообщением." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "visit_r1_p3b" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCallCount, 1, "executor must be called exactly once (round-1 only)");
  const r1Result = result.tool_results.find((r) => r.call_id === "ba_r1_p3b");
  assert.ok(r1Result, "round-1 booking result must be in tool_results");
  assert.equal((r1Result!.data as Record<string, unknown>).created_visit, true, "round-1 booking must show created");
  const r2Result = result.tool_results.find((r) => r.call_id === "ba_r2_p3b");
  if (r2Result) {
    assert.equal((r2Result.data as Record<string, unknown>).created_visit, false, "round-2 must not create a visit");
    assert.equal((r2Result.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  }
});

test("P3-3: availability round-1, one booking.apply round-2 → booking executes, round-2 request in tool_requests", async () => {
  let executorCallCount = 0;

  const REGISTRY: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима", service: null,
        slot: null, booking_contact: { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_1" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: "Анна Козлова", service: "чистка",
        slot: null, booking_contact: { phone_number: "+420111222333", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: null },
        status: "collecting", missing: ["slot"],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", call_id: "avail_p3c", arguments: { requested_date: "2027-08-15", service_interest: "чистка" } }],
      },
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_p3c",
          arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Анна записана на 11:00!" } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2027-08-15T11:00:00", service: "чистка" }] } }),
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "visit_p3c" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, booking_subjects: REGISTRY, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCallCount, 1, "booking executor must be called exactly once (round-2)");
  const hasBaInRequests = result.tool_requests.some((r) => r.tool === "booking.apply" && r.call_id === "ba_p3c");
  assert.ok(hasBaInRequests, "round-2 booking.apply must be in tool_requests (processedToolRequests fix)");
  assert.equal(result.execution_subject_id, "subject_2", "execution_subject_id must be subject_2");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).created_visit, true);
});

// ── Point 4: No-slots guard ordering ──────────────────────────────────────────

test("P4-1: round-1 avail returns 0 slots + round-2 booking.apply subject_2 (no registry) → registry bootstrapped, execution_subject_id=subject_2, no_available_slots, executor=0", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "avail_p4", arguments: { requested_date: "2027-08-15", service_interest: "чистка" } }] },
      {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_p4", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
      },
      { type: "final_response", final_response: { final_patient_reply: "К сожалению, нет свободного времени." } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } }; },
    },
    bookingProcessStateRepository: { async loadState() { return null; }, async saveState() {} },
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "executor must NOT be called when no slots");
  assert.ok(result.booking_subjects_after_resolution, "registry must be bootstrapped even when no slots");
  const s2 = result.booking_subjects_after_resolution!.subjects.find((s) => s.id === "subject_2");
  assert.ok(s2, "registry must have subject_2");
  assert.equal(result.execution_subject_id, "subject_2", "execution_subject_id must be subject_2");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "no_available_slots", "no-slots guard must fire");
});

test("P4-2: round-2 booking.apply missing subject_id + zero slots → subject_resolution_conflict (no-slots must NOT mask subject contract)", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "avail_p4b", arguments: { requested_date: "2027-08-15" } }] },
      {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_p4b", arguments: { first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Уточните." } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: { async loadState() { return null; }, async saveState() {} },
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false);
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "subject_resolution_conflict", "must be subject_resolution_conflict, NOT no_available_slots");
  assert.equal((baResult!.data as Record<string, unknown>).reason, "subject_id_required");
});

// ── Point 5: Fresh vs stale typed phone ───────────────────────────────────────

test("P5-2: prior registry + FRESH typed phone (current turn) + self booking → fresh phone used by executor", async () => {
  const FRESH_PHONE = "+420777888999";
  let capturedPhone: string | undefined;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_p5b", arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "осмотр", requested_date: "2027-08-15", requested_time: "11:00" } }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Рима записана!" } },
    ]),
    executors: {
      "booking.apply": async (ctx) => {
        capturedPhone = ctx.phone_number;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  await loop.runTurn({
    ...BASE_TURN,
    provided_phone: { phone_number: FRESH_PHONE, phone_source: "typed", phone_trust: "unverified", phone_consent: false, phone_collected_at: new Date().toISOString() },
    current_turn_typed_phone: FRESH_PHONE,
    had_booking_subjects: true,
  });

  assert.equal(capturedPhone, FRESH_PHONE, "fresh typed phone from current turn must be used even when had_booking_subjects=true");
});

test("P5-3: prior registry + fresh typed phone + subject_2 → pending_typed_phone blocks booking (Guard I)", async () => {
  let executorCalled = false;
  const TYPED_PHONE = "+420555666777";

  const REGISTRY: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2" as SubjectId,
    subjects: [
      { id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: null, service: null, slot: null, booking_contact: null, status: "collecting", missing: [] },
      { id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: "Анна Козлова", service: "чистка", slot: null, booking_contact: null, status: "collecting", missing: ["slot", "booking_contact"] },
    ],
    pending_typed_phone: TYPED_PHONE,
    max_subjects: 4,
  };

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_p5c", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Уточните чей телефон." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, booking_subjects: REGISTRY, channel_contact: TRUSTED_CONTACT, current_turn_typed_phone: TYPED_PHONE, had_booking_subjects: true });

  assert.equal(executorCalled, false, "executor must not be called when pending_typed_phone present (Guard I)");
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "pending_phone_classification");
});

// ── Point 8: Regression tests for invalid targets ─────────────────────────────

async function runWithInvalidSubjectId(subjectId: unknown): Promise<void> {
  let executorCalled = false;
  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_inv", arguments: { subject_id: subjectId, first_name: "Тест", last_name: "Пациент", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Ошибка." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "mock-visit-id" } }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });
  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });
  assert.equal(executorCalled, false, `executor must NOT be called for invalid subject_id: ${JSON.stringify(subjectId)}`);
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult, `guarded result must appear for: ${JSON.stringify(subjectId)}`);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "subject_resolution_conflict", `must be conflict for: ${JSON.stringify(subjectId)}`);
}

test("P8-1: no registry + subject_99 → subject_resolution_conflict, executor=0", () => runWithInvalidSubjectId("subject_99"));
test("P8-2: no registry + subject_0 → subject_resolution_conflict, executor=0", () => runWithInvalidSubjectId("subject_0"));
test("P8-3: no registry + numeric subject ID (5) → subject_resolution_conflict, executor=0", () => runWithInvalidSubjectId(5));
test("P8-4: no registry + empty string subject ID → subject_resolution_conflict, executor=0", () => runWithInvalidSubjectId(""));

test("P8-5: active registry + invalid subject ID → subject_resolution_conflict, executor=0", async () => {
  const REGISTRY: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2" as SubjectId,
    subjects: [
      { id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: null, service: null, slot: null, booking_contact: { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_1" as SubjectId, collected_at: null }, status: "collecting", missing: [] },
      { id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: "Анна", service: "чистка", slot: "2027-08-15T11:00", booking_contact: null, status: "collecting", missing: ["booking_contact"] },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };
  let executorCalled = false;
  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "booking.apply", call_id: "ba_p8e", arguments: { subject_id: "subject_invalid", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Ошибка." } },
    ]),
    executors: { "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; } },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });
  const result = await loop.runTurn({ ...BASE_TURN, booking_subjects: REGISTRY, channel_contact: TRUSTED_CONTACT });
  assert.equal(executorCalled, false);
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "subject_resolution_conflict");
  assert.equal((baResult!.data as Record<string, unknown>).reason, "invalid_subject_id_format");
});

test("P8-6: round-2 + invalid subject ID ('self') → subject_resolution_conflict, executor=0", async () => {
  let executorCalled = false;
  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "av_p8f", arguments: { requested_date: "2027-08-15" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "booking.apply", call_id: "ba_p8f", arguments: { subject_id: "self", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Ошибка." } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2027-08-15T11:00:00" }] } }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });
  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });
  assert.equal(executorCalled, false);
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "subject_resolution_conflict");
  assert.equal((baResult!.data as Record<string, unknown>).reason, "invalid_subject_id_format");
});

test("P8-7: zero slots + missing subject ID → subject_resolution_conflict (not no_available_slots)", async () => {
  let executorCalled = false;
  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "av_p8g", arguments: { requested_date: "2027-08-15" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "booking.apply", call_id: "ba_p8g", arguments: { first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Ошибка." } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: { async loadState() { return null; }, async saveState() {} },
  });
  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });
  assert.equal(executorCalled, false);
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "subject_resolution_conflict");
});

test("P8-8: zero slots + invalid subject ID → subject_resolution_conflict (not no_available_slots)", async () => {
  let executorCalled = false;
  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "av_p8h", arguments: { requested_date: "2027-08-15" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "booking.apply", call_id: "ba_p8h", arguments: { subject_id: "subject_99", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Ошибка." } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [] } }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: { async loadState() { return null; }, async saveState() {} },
  });
  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });
  assert.equal(executorCalled, false);
  const baResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(baResult);
  assert.equal((baResult!.data as Record<string, unknown>).booking_status, "subject_resolution_conflict");
  assert.equal((baResult!.data as Record<string, unknown>).reason, "invalid_subject_id_format");
});

// ── OC-2: Real two-turn orchestrator test with actual runtime loop ─────────────

test("OC-2: real two-turn orchestrator — turn-1 bootstraps registry via subject_intent, turn-2 runs real loop with round-2 booking.apply subject_2", async () => {
  const CLINIC_CODE_OC2 = "clinic_oc2";
  const CLINIC_UUID_OC2 = "22222222-3333-4444-8555-666666666666";
  const CONTACT_UUID_OC2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

  let savedBookingSubjectsOC2: BookingSubjectsState | null = null;
  let turn2ExecutorCallCount = 0;
  let mergeCallsSeen = 0;

  const stubClinicResolverOC2: ClinicIdentityResolver = {
    async resolveClinicIdentity(input) {
      if (input.clinic_identifier === CLINIC_CODE_OC2) {
        return { ok: true, data: { clinic_id: CLINIC_UUID_OC2, clinic_code: CLINIC_CODE_OC2 } };
      }
      return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
    },
  };

  const stubPersistenceOC2: TurnPersistenceRepository = {
    async getOrCreateContact() {
      return { ok: true, data: { contact_id: CONTACT_UUID_OC2, clinic_id: CLINIC_UUID_OC2 } };
    },
    async registerInboundEvent() {
      return { ok: true, data: { inbound_event_id: `evt_oc2_${++mergeCallsSeen}` } };
    },
    async saveMessage() {
      return { ok: true, data: { message_id: "msg_oc2" } };
    },
    async mergeConversationState(input) {
      if (input.control_flags?.booking_subjects) {
        savedBookingSubjectsOC2 = input.control_flags.booking_subjects as BookingSubjectsState;
      }
      return { ok: true, data: { ok: true } };
    },
  };

  const ctxRepoOC2: RuntimeContextRepository = {
    async loadRuntimeContext() {
      let bookingSubjectsForLoad: BookingSubjectsState | null = null;
      if (savedBookingSubjectsOC2) {
        // Simulate phone ownership resolved between turns: add phone to subject_2
        const subjects = savedBookingSubjectsOC2.subjects.map((s) => {
          if (s.id === "subject_2") {
            const bc: BookingContact = { phone_number: "+420111222333", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: new Date().toISOString() };
            return { ...s, booking_contact: bc };
          }
          return s;
        });
        bookingSubjectsForLoad = { ...savedBookingSubjectsOC2, subjects, pending_typed_phone: null };
      }
      return {
        ok: true,
        data: {
          known_contact: {},
          conversation_state: {},
          topic_memory: null,
          channel_contact: { phone_number: "+380991350135", phone_source: "telegram_contact_button" as const, phone_consent: true, phone_collected_at: "2026-07-01T00:00:00.000Z" },
          provided_phone: null,
          booking_subjects: bookingSubjectsForLoad,
          selected_slot_starts_at: "2027-08-15T11:00:00",
          case_context_lite: null,
          runtime_flags: { has_durable_context: true, context_source: "supabase" as const, context_loaded_at: new Date().toISOString() },
          recent_history: [],
        },
      };
    },
  };

  // Turn 1: model emits subject_intent in final_response → orchestrator bootstraps registry
  const turn1Loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "final_response",
        final_response: {
          final_patient_reply: "Хорошо, оформляю запись для мамы. Как её зовут?",
          subject_intent: { action: "create_subjects" as const, target: "mentioned_person" as const, count: 1, labels: ["мама"], confidence: "high" as const },
        },
      },
    ]),
    executors: {},
    bookingProcessStateRepository: { async loadState() { return null; }, async saveState() {} },
  });
  const turn1Service = createRuntimeTurnService({ agent: turn1Loop });

  const result1OC2 = await runRuntimeTurnOrchestrated(
    { clinic_code: CLINIC_CODE_OC2, channel: "telegram" as const, external_user_id: "user_oc2", chat_id: "888", text: "Запишите мою маму", meta: { update_id: 2001, message_id: 301, username: null, first_name: null, last_name: null, telegram_chat_type: "private" as const } },
    { runtimeTurnService: turn1Service, clinicIdentityResolver: stubClinicResolverOC2, turnPersistenceRepository: stubPersistenceOC2, runtimeContextRepository: ctxRepoOC2 },
  );
  assert.ok(result1OC2.outcome === "success" || result1OC2.outcome === "error", `turn 1 OC2: ${result1OC2.outcome}`);
  assert.ok(savedBookingSubjectsOC2 !== null, "turn 1 must persist booking_subjects");
  assert.ok(savedBookingSubjectsOC2!.subjects.find((s) => s.id === "subject_2"), "registry must have subject_2 after turn 1");

  // Turn 2: real loop — availability.check round-1 + booking.apply subject_2 round-2
  const turn2Loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "avail_oc2", arguments: { requested_date: "2027-08-15", service_interest: "чистка" } }] },
      { type: "tool_requests", tool_requests: [{ tool: "booking.apply", call_id: "ba_oc2", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }] },
      { type: "final_response", final_response: { final_patient_reply: "Анна Козлова записана на чистку 20 июля в 11:00!" } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2027-08-15T11:00:00", service: "чистка" }] } }),
      "booking.apply": async () => {
        turn2ExecutorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "visit_oc2_real" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });
  const turn2Service = createRuntimeTurnService({ agent: turn2Loop });

  const result2OC2 = await runRuntimeTurnOrchestrated(
    { clinic_code: CLINIC_CODE_OC2, channel: "telegram" as const, external_user_id: "user_oc2", chat_id: "888", text: "Запишите маму Анну Козлову на 20 июля в 11:00 на чистку", meta: { update_id: 2002, message_id: 302, username: null, first_name: null, last_name: null, telegram_chat_type: "private" as const } },
    { runtimeTurnService: turn2Service, clinicIdentityResolver: stubClinicResolverOC2, turnPersistenceRepository: stubPersistenceOC2, runtimeContextRepository: ctxRepoOC2 },
  );
  assert.ok(result2OC2.outcome === "success" || result2OC2.outcome === "error", `turn 2 OC2: ${result2OC2.outcome}`);

  assert.equal(turn2ExecutorCallCount, 1, "booking executor must be called exactly once in turn 2");

  // Final registry must show subject_2 as booked
  assert.ok(savedBookingSubjectsOC2 !== null, "turn 2 must persist updated registry");
  const finalS2 = savedBookingSubjectsOC2!.subjects.find((s) => s.id === "subject_2");
  assert.ok(finalS2, "subject_2 must exist in final registry");
  assert.equal(finalS2!.status, "booked", "subject_2 must be booked after turn 2");

  // subject_1 must remain unchanged (not booked)
  const finalS1 = savedBookingSubjectsOC2!.subjects.find((s) => s.id === "subject_1");
  assert.ok(finalS1);
  assert.notEqual(finalS1!.status, "booked", "subject_1 must NOT be booked");

  // Reply must not contain raw JSON
  if (result2OC2.outcome === "success") {
    const reply = result2OC2.payload.final_patient_reply;
    assert.ok(!reply.includes("{\""), "reply must not contain raw JSON");
    assert.ok(!reply.includes("booking_status"), "reply must not contain booking_status field name");
  }
});

// ── Point 1: booking_apply_resolution + P3-2 strengthened ────────────────────

test("P3-2 (strengthened): round-1 booking subject_1 executed → round-2 booking blocked → booking_apply_resolution points to round-1, postUpdateBookingSubjects books subject_1 only", async () => {
  const FIRST_CALL_ID = "ba_r1_p3b_str";
  let executorCallCount = 0;

  const REGISTRY: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: null, service: null, slot: null,
        booking_contact: { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_1" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: "Анна Козлова", service: "чистка", slot: "2027-08-15T11:00",
        booking_contact: { phone_number: "+420111222333", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: FIRST_CALL_ID,
          arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" },
        }],
      },
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_r2_p3b_str",
          arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Рима записана. Анну оформим следующим сообщением." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "visit_s1" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, booking_subjects: REGISTRY, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCallCount, 1, "executor called exactly once");

  // booking_apply_resolution must point to round-1
  assert.ok(result.booking_apply_resolution, "booking_apply_resolution must be present");
  assert.equal(result.booking_apply_resolution!.call_id, FIRST_CALL_ID, "resolution.call_id must be round-1 call_id");
  assert.equal(result.booking_apply_resolution!.subject_id, "subject_1", "resolution.subject_id must be subject_1");

  // The round-2 result must be blocked
  const r2Result = result.tool_results.find((r) => r.call_id === "ba_r2_p3b_str");
  if (r2Result) {
    assert.equal((r2Result.data as Record<string, unknown>).created_visit, false);
    assert.equal((r2Result.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  }

  // Apply postUpdateBookingSubjects using the resolution
  const { postUpdateBookingSubjects } = await import("../src/runtime/bookingSubjectsState.ts");
  const baseRegistry = result.booking_subjects_after_resolution ?? REGISTRY;
  const updated = postUpdateBookingSubjects({
    current: baseRegistry,
    toolRequests: result.tool_requests,
    toolResults: result.tool_results,
    bookingApplyResolution: result.booking_apply_resolution ?? null,
  });

  const s1 = updated.subjects.find((s) => s.id === "subject_1")!;
  const s2 = updated.subjects.find((s) => s.id === "subject_2")!;
  assert.equal(s1.status, "booked", "subject_1 must be booked");
  assert.notEqual(s2.status, "booked", "subject_2 must NOT be booked");
});

test("New-P1: integration — round-1 booking subject_1 success, round-2 blocks second booking → mergeConversationState persists subject_1 booked, subject_2 collecting", async () => {
  const CLINIC_CODE_P1 = "clinic_p1_int";
  const CLINIC_UUID_P1 = "33333333-4444-4555-8666-777777777777";
  const CONTACT_UUID_P1 = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
  let executorCallCount = 0;
  let persistedState: BookingSubjectsState | null = null;

  const REGISTRY: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима Шевченко", service: "чистка",
        slot: "2027-08-15T11:00",
        booking_contact: { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_1" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: "Анна Козлова", service: "чистка",
        slot: "2027-08-15T11:00",
        booking_contact: { phone_number: "+420111222333", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const ctxRepo: RuntimeContextRepository = {
    async loadRuntimeContext() {
      return {
        ok: true,
        data: {
          known_contact: {},
          conversation_state: {},
          topic_memory: null,
          channel_contact: { phone_number: "+380991350135", phone_source: "telegram_contact_button" as const, phone_consent: true, phone_collected_at: "2026-07-01T00:00:00.000Z" },
          provided_phone: null,
          booking_subjects: REGISTRY,
          selected_slot_starts_at: "2027-08-15T11:00:00",
          case_context_lite: null,
          runtime_flags: { has_durable_context: true, context_source: "supabase" as const, context_loaded_at: new Date().toISOString() },
          recent_history: [],
        },
      };
    },
  };

  const persistRepo: TurnPersistenceRepository = {
    async getOrCreateContact() { return { ok: true, data: { contact_id: CONTACT_UUID_P1, clinic_id: CLINIC_UUID_P1 } }; },
    async registerInboundEvent() { return { ok: true, data: { inbound_event_id: "evt_p1" } }; },
    async saveMessage() { return { ok: true, data: { message_id: "msg_p1" } }; },
    async mergeConversationState(input) {
      if (input.control_flags?.booking_subjects) {
        persistedState = input.control_flags.booking_subjects as BookingSubjectsState;
      }
      return { ok: true, data: { ok: true } };
    },
  };

  const clinicResolver: ClinicIdentityResolver = {
    async resolveClinicIdentity(input) {
      if (input.clinic_identifier === CLINIC_CODE_P1) {
        return { ok: true, data: { clinic_id: CLINIC_UUID_P1, clinic_code: CLINIC_CODE_P1 } };
      }
      return { ok: false, error: { code: "clinic_not_found", message: "not found", retryable: false } };
    },
  };

  const turnLoop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_p1_int_r1",
          arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" },
        }],
      },
      {
        type: "tool_requests",
        tool_requests: [{
          tool: "booking.apply",
          call_id: "ba_p1_int_r2",
          arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Рима записана. Анну оформим в следующий раз." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "visit_p1" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const turnService = createRuntimeTurnService({ agent: turnLoop });

  await runRuntimeTurnOrchestrated(
    { clinic_code: CLINIC_CODE_P1, channel: "telegram" as const, external_user_id: "user_p1", chat_id: "999", text: "Запишите меня", meta: { update_id: 3001, message_id: 401, username: null, first_name: null, last_name: null, telegram_chat_type: "private" as const } },
    { runtimeTurnService: turnService, clinicIdentityResolver: clinicResolver, turnPersistenceRepository: persistRepo, runtimeContextRepository: ctxRepo },
  );

  assert.equal(executorCallCount, 1, "executor called exactly once");
  assert.ok(persistedState !== null, "booking_subjects must be persisted");

  const s1 = persistedState!.subjects.find((s) => s.id === "subject_1");
  const s2 = persistedState!.subjects.find((s) => s.id === "subject_2");
  assert.ok(s1, "subject_1 exists in persisted state");
  assert.ok(s2, "subject_2 exists in persisted state");
  assert.equal(s1!.status, "booked", "subject_1 must be booked in persisted state");
  assert.notEqual(s2!.status, "booked", "subject_2 must NOT be booked");
  assert.ok(s1!.patient_name, "subject_1 name saved");
});

// ── Point 2: round-2 multiple booking.apply guard ─────────────────────────────

test("New-P2-round2-multi: availability round-1 + two booking.apply round-2 → executor=0, both call_ids closed in tool_results", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "av_r2m", arguments: { requested_date: "2027-08-15" } }] },
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "booking.apply", call_id: "ba_r2m_1", arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } },
          { tool: "booking.apply", call_id: "ba_r2m_2", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "осмотр", requested_date: "2027-08-15", requested_time: "11:00" } },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Пожалуйста, уточните запись по одному." } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2027-08-15T11:00:00" }] } }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "executor must NOT be called");

  // Both booking.apply call_ids must have results
  const r1 = result.tool_results.find((r) => r.call_id === "ba_r2m_1");
  const r2 = result.tool_results.find((r) => r.call_id === "ba_r2m_2");
  assert.ok(r1, "ba_r2m_1 must have a tool result");
  assert.ok(r2, "ba_r2m_2 must have a tool result");
  assert.equal((r1!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  assert.equal((r2!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  assert.equal((r1!.data as Record<string, unknown>).created_visit, false);
  assert.equal((r2!.data as Record<string, unknown>).created_visit, false);
});

test("New-P1-round1-multi-both-closed: two booking.apply in round-1 → both call_ids get synthetic results", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "booking.apply", call_id: "ba_r1m_a", arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } },
          { tool: "booking.apply", call_id: "ba_r1m_b", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "осмотр", requested_date: "2027-08-15", requested_time: "11:00" } },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Пожалуйста, уточните запись по одному." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "executor must NOT be called");

  // Both call_ids must be in tool_results
  const ra = result.tool_results.find((r) => r.call_id === "ba_r1m_a");
  const rb = result.tool_results.find((r) => r.call_id === "ba_r1m_b");
  assert.ok(ra, "ba_r1m_a must have a result");
  assert.ok(rb, "ba_r1m_b must have a result");
  assert.equal((ra!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  assert.equal((rb!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  assert.equal((ra!.data as Record<string, unknown>).created_visit, false);
  assert.equal((rb!.data as Record<string, unknown>).created_visit, false);
});

// ── Point 4: Strict v2 → v3 migration ─────────────────────────────────────────

const { normalizeBookingSubjectsState: normBS } = await import("../src/runtime/bookingSubjectsState.ts");

function makeValidV2(): Record<string, unknown> {
  return {
    version: 2,
    active_subject_id: "subject_1",
    subjects: [
      {
        id: "subject_1",
        role: "sender",
        label: null,
        patient_name: "Рима Шевченко",
        service: "чистка",
        slot: "2027-08-15T11:00",
        status: "collecting",
        booking_contact: {
          phone_number: "+380991350135",
          source: "telegram_contact_button",
          trust: "trusted",
          owner_subject_id: "subject_1",
          collected_at: null,
        },
      },
      {
        id: "subject_2",
        role: "mentioned_person",
        label: "мама",
        patient_name: "Анна Козлова",
        service: null,
        slot: null,
        status: "collecting",
        booking_contact: null,
      },
    ],
    pending_typed_phone: null,
  };
}

test("v2-migration-valid: valid v2 fixture → valid canonical v3 state", () => {
  const result = normBS(makeValidV2());
  assert.ok(result !== null, "valid v2 must migrate to v3");
  assert.equal(result!.version, 3);
  assert.equal(result!.active_subject_id, "subject_1");
  assert.equal(result!.subjects.length, 2);
  assert.equal(result!.subjects[0].role, "sender");
  assert.equal(result!.subjects[1].role, "mentioned_person");
});

test("v2-migration-subject_99: v2 with subject_99 ID → null", () => {
  const bad = makeValidV2();
  (bad.subjects as Record<string, unknown>[])[0].id = "subject_99";
  bad.active_subject_id = "subject_99";
  assert.equal(normBS(bad), null);
});

test("v2-migration-duplicate-ids: v2 with duplicate subject IDs → null", () => {
  const bad = makeValidV2();
  (bad.subjects as Record<string, unknown>[])[1].id = "subject_1";
  assert.equal(normBS(bad), null);
});

test("v2-migration-two-senders: v2 with two senders → null", () => {
  const bad = makeValidV2();
  (bad.subjects as Record<string, unknown>[])[1].role = "sender";
  assert.equal(normBS(bad), null);
});

test("v2-migration-sender-subject_2: v2 with sender on subject_2 → null", () => {
  const bad = makeValidV2();
  (bad.subjects as Record<string, unknown>[])[0].role = "mentioned_person";
  (bad.subjects as Record<string, unknown>[])[1].role = "sender";
  bad.active_subject_id = "subject_2";
  assert.equal(normBS(bad), null);
});

test("v2-migration-unknown-role: v2 with unknown role string → null", () => {
  const bad = makeValidV2();
  (bad.subjects as Record<string, unknown>[])[1].role = "patient";
  assert.equal(normBS(bad), null);
});

test("v2-migration-invalid-contact-source: v2 with invalid booking_contact source → null", () => {
  const bad = makeValidV2();
  const bc = { phone_number: "+380991350135", source: "smoke_signal", trust: "trusted", owner_subject_id: "subject_1", collected_at: null };
  (bad.subjects as Record<string, unknown>[])[0].booking_contact = bc;
  assert.equal(normBS(bad), null);
});

test("v2-migration-active-id-missing: v2 active_subject_id not in subjects → null", () => {
  const bad = makeValidV2();
  bad.active_subject_id = "subject_3";
  assert.equal(normBS(bad), null);
});

// ── Point 1: hasCompleteBookingApplyProof — partial proof rejects booked status ──

const PROOF_STATE: BookingSubjectsState = {
  version: 3,
  status: "active",
  active_subject_id: "subject_2" as SubjectId,
  subjects: [
    { id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима", service: null, slot: null, booking_contact: null, status: "collecting", missing: [] },
    {
      id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: "Анна", service: "чистка",
      slot: "2027-08-15T11:00",
      booking_contact: { phone_number: "+420111222333", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: null },
      status: "collecting", missing: [],
    },
  ],
  pending_typed_phone: null,
  max_subjects: 4,
};

test("Proof-1: missing cliniccard_visit_id → subject NOT marked booked (partial proof rejected)", () => {
  const updated = postUpdateBookingSubjects({
    current: PROOF_STATE,
    toolRequests: [{ tool: "booking.apply", call_id: "ba_pf1", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
    toolResults: [{ tool: "booking.apply", call_id: "ba_pf1", status: "success", data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } }],
    executionSubjectId: "subject_2" as SubjectId,
  });
  const s2 = updated.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "collecting", "missing cliniccard_visit_id must not promote to booked");
});

test("Proof-2: booking_status=missing_phone → subject NOT marked booked", () => {
  const updated = postUpdateBookingSubjects({
    current: PROOF_STATE,
    toolRequests: [{ tool: "booking.apply", call_id: "ba_pf2", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
    toolResults: [{ tool: "booking.apply", call_id: "ba_pf2", status: "success", data: { booking_status: "missing_phone", created_visit: false, may_claim_booked: false, cliniccard_visit_id: null } }],
    executionSubjectId: "subject_2" as SubjectId,
  });
  const s2 = updated.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "collecting", "booking_status=missing_phone must not promote to booked");
});

test("Proof-3: may_claim_booked=false → subject NOT marked booked", () => {
  const updated = postUpdateBookingSubjects({
    current: PROOF_STATE,
    toolRequests: [{ tool: "booking.apply", call_id: "ba_pf3", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
    toolResults: [{ tool: "booking.apply", call_id: "ba_pf3", status: "success", data: { booking_status: "visit_created", created_visit: true, may_claim_booked: false, cliniccard_visit_id: "v-partial" } }],
    executionSubjectId: "subject_2" as SubjectId,
  });
  const s2 = updated.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "collecting", "may_claim_booked=false must not promote to booked");
});

test("Proof-4: tool result status=denied → subject NOT marked booked", () => {
  const updated = postUpdateBookingSubjects({
    current: PROOF_STATE,
    toolRequests: [{ tool: "booking.apply", call_id: "ba_pf4", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
    toolResults: [{ tool: "booking.apply", call_id: "ba_pf4", status: "denied", error: { code: "guard_block", message: "guard blocked" } }],
    executionSubjectId: "subject_2" as SubjectId,
  });
  const s2 = updated.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "collecting", "status=denied must not promote to booked");
});

test("Proof-5: full proof (all 5 fields) → subject marked booked", () => {
  const updated = postUpdateBookingSubjects({
    current: PROOF_STATE,
    toolRequests: [{ tool: "booking.apply", call_id: "ba_pf5", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
    toolResults: [{ tool: "booking.apply", call_id: "ba_pf5", status: "success", data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "visit-proof5" } }],
    executionSubjectId: "subject_2" as SubjectId,
  });
  const s2 = updated.subjects.find((s) => s.id === "subject_2");
  assert.equal(s2?.status, "booked", "full proof must mark subject as booked");
});

// ── Point 2: Mixed tool requests in same round ─────────────────────────────────

test("Mixed-R1-avail: round-1 booking A + booking B + availability C → multiple guard fires, all 3 call_ids closed", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "booking.apply", call_id: "ba_mr1_a", arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } },
          { tool: "booking.apply", call_id: "ba_mr1_b", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "осмотр", requested_date: "2027-08-15", requested_time: "11:30" } },
          { tool: "availability.check", call_id: "av_mr1_c", arguments: { requested_date: "2027-08-15" } },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Пожалуйста, делайте по одной записи." } },
    ]),
    executors: {
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
      "availability.check": async () => { executorCalled = true; return { status: "success" as const, data: { slots: [] } }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "no executor must run when multiple booking.apply in same round");

  const rA = result.tool_results.find((r) => r.call_id === "ba_mr1_a");
  const rB = result.tool_results.find((r) => r.call_id === "ba_mr1_b");
  const rC = result.tool_results.find((r) => r.call_id === "av_mr1_c");
  assert.ok(rA, "ba_mr1_a must have a result");
  assert.ok(rB, "ba_mr1_b must have a result");
  assert.ok(rC, "av_mr1_c must have a result");

  assert.equal((rA!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests", "ba_mr1_a must be blocked");
  assert.equal((rB!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests", "ba_mr1_b must be blocked");
  assert.equal((rA!.data as Record<string, unknown>).created_visit, false);
  assert.equal((rB!.data as Record<string, unknown>).created_visit, false);
  assert.equal(rC!.status, "denied", "availability.check must be denied when booking round aborted");
  assert.equal((rC!.error as Record<string, unknown>).code, "turn_aborted_due_to_multiple_booking_requests");
});

test("Mixed-R2-kb: avail round-1 + [booking A + booking B + kb.search C] round-2 → all 3 R2 closed, executors=0", async () => {
  let executorCalled = false;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      { type: "tool_requests", tool_requests: [{ tool: "availability.check", call_id: "av_r1_mr2", arguments: { requested_date: "2027-08-15" } }] },
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "booking.apply", call_id: "ba_mr2_a", arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } },
          { tool: "booking.apply", call_id: "ba_mr2_b", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "осмотр", requested_date: "2027-08-15", requested_time: "11:30" } },
          { tool: "kb.search", call_id: "kb_mr2_c", arguments: { query: "стоимость чистки" } },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Пожалуйста, делайте по одной записи." } },
    ]),
    executors: {
      "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2027-08-15T11:00:00" }] } }),
      "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
      "kb.search": async () => { executorCalled = true; return { status: "success" as const, data: { results: [] } }; },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, channel_contact: TRUSTED_CONTACT });

  assert.equal(executorCalled, false, "no R2 executor must run when multiple booking.apply detected in R2");

  const rA = result.tool_results.find((r) => r.call_id === "ba_mr2_a");
  const rB = result.tool_results.find((r) => r.call_id === "ba_mr2_b");
  const rC = result.tool_results.find((r) => r.call_id === "kb_mr2_c");
  assert.ok(rA, "ba_mr2_a must have a result");
  assert.ok(rB, "ba_mr2_b must have a result");
  assert.ok(rC, "kb_mr2_c must have a result");

  assert.equal((rA!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  assert.equal((rB!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests");
  assert.equal(rC!.status, "denied");
  assert.equal((rC!.error as Record<string, unknown>).code, "turn_aborted_due_to_multiple_booking_requests");
});

test("Mixed-R1-books-then-R2-multi: round-1 books subject_1 (1 executor call), round-2 [ba_sub2 + ba_sub3] → resolution preserved, R2 both blocked", async () => {
  const REGISTRY_3S: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1" as SubjectId,
    subjects: [
      {
        id: "subject_1" as SubjectId, role: "sender", label: null, patient_name: "Рима Шевченко", service: "чистка",
        slot: "2027-08-15T11:00",
        booking_contact: { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_1" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
      {
        id: "subject_2" as SubjectId, role: "mentioned_person", label: "мама", patient_name: "Анна Козлова", service: "осмотр",
        slot: "2027-08-15T12:00",
        booking_contact: { phone_number: "+420111222333", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
      {
        id: "subject_3" as SubjectId, role: "mentioned_person", label: "папа", patient_name: "Петр Козлов", service: "пломба",
        slot: "2027-08-15T13:00",
        booking_contact: { phone_number: "+420333444555", source: "typed", trust: "unverified", owner_subject_id: "subject_3" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  let executorCallCount = 0;

  const loop = createRuntimeAgentLoop({
    now: new Date("2027-08-15T07:00:00Z"),
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        tool_requests: [{ tool: "booking.apply", call_id: "ba_r1_s1", arguments: { subject_id: "subject_1", first_name: "Рима", last_name: "Шевченко", service: "чистка", requested_date: "2027-08-15", requested_time: "11:00" } }],
      },
      {
        type: "tool_requests",
        tool_requests: [
          { tool: "booking.apply", call_id: "ba_r2_s2", arguments: { subject_id: "subject_2", first_name: "Анна", last_name: "Козлова", service: "осмотр", requested_date: "2027-08-15", requested_time: "12:00" } },
          { tool: "booking.apply", call_id: "ba_r2_s3", arguments: { subject_id: "subject_3", first_name: "Петр", last_name: "Козлов", service: "пломба", requested_date: "2027-08-15", requested_time: "13:00" } },
        ],
      },
      { type: "final_response", final_response: { final_patient_reply: "Рима записана. Для мамы и папы нужно по одной записи." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCallCount++;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true, cliniccard_visit_id: "visit-s1-r1" } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2027-08-15T11:00:00"),
  });

  const result = await loop.runTurn({ ...BASE_TURN, booking_subjects: REGISTRY_3S, channel_contact: TRUSTED_CONTACT });

  // Round-1: exactly 1 booking.apply executed (subject_1)
  assert.equal(executorCallCount, 1, "executor called exactly once (round-1 for subject_1)");

  // Round-2 results: both call_ids must be closed with multiple_booking_apply_requests
  const rS2 = result.tool_results.find((r) => r.call_id === "ba_r2_s2");
  const rS3 = result.tool_results.find((r) => r.call_id === "ba_r2_s3");
  assert.ok(rS2, "ba_r2_s2 must have a result");
  assert.ok(rS3, "ba_r2_s3 must have a result");
  assert.equal((rS2!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests", "ba_r2_s2 must be blocked");
  assert.equal((rS3!.data as Record<string, unknown>).reason, "multiple_booking_apply_requests", "ba_r2_s3 must be blocked");

  // Round-1 booking_apply_resolution must be preserved (subject_1, call ba_r1_s1)
  assert.equal(result.booking_apply_resolution?.subject_id, "subject_1", "resolution subject_id must be subject_1 from round-1");
  assert.equal(result.booking_apply_resolution?.call_id, "ba_r1_s1", "resolution call_id must be ba_r1_s1 from round-1");
});

// ── Point 3: Strict v2 migration — owner_subject_id and status validation ────────

test("v2-owner-invalid-string: booking_contact.owner_subject_id='subject_99' → null", () => {
  const bad = makeValidV2();
  const bc = { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: "subject_99", collected_at: null };
  (bad.subjects as Record<string, unknown>[])[0].booking_contact = bc;
  assert.equal(normBS(bad), null, "owner_subject_id='subject_99' must reject entire state");
});

test("v2-owner-numeric: booking_contact.owner_subject_id=123 → null", () => {
  const bad = makeValidV2();
  const bc = { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: 123, collected_at: null };
  (bad.subjects as Record<string, unknown>[])[0].booking_contact = bc;
  assert.equal(normBS(bad), null, "numeric owner_subject_id must reject entire state");
});

test("v2-owner-object: booking_contact.owner_subject_id={} → null", () => {
  const bad = makeValidV2();
  const bc = { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: {}, collected_at: null };
  (bad.subjects as Record<string, unknown>[])[0].booking_contact = bc;
  assert.equal(normBS(bad), null, "object owner_subject_id must reject entire state");
});

test("v2-owner-null-non-shared: owner_subject_id=null + telegram_contact_button source → canonicalized to self (subject_1)", () => {
  const fixture = makeValidV2();
  const bc = { phone_number: "+380991350135", source: "telegram_contact_button", trust: "trusted", owner_subject_id: null, collected_at: null };
  (fixture.subjects as Record<string, unknown>[])[0].booking_contact = bc;
  const result = normBS(fixture);
  assert.ok(result !== null, "null owner_subject_id with non-shared source must migrate successfully");
  const s1 = result!.subjects.find((s) => s.id === "subject_1");
  assert.ok(s1, "subject_1 must exist");
  assert.equal(s1!.booking_contact?.owner_subject_id, "subject_1", "null owner must canonicalize to self (subject_1)");
});

test("v2-status-unknown: subject status='unknown' → null (no silent coercion)", () => {
  const bad = makeValidV2();
  (bad.subjects as Record<string, unknown>[])[0].status = "unknown";
  assert.equal(normBS(bad), null, "status='unknown' must reject entire state");
});

test("v2-status-numeric: subject status=1 → null", () => {
  const bad = makeValidV2();
  (bad.subjects as Record<string, unknown>[])[0].status = 1;
  assert.equal(normBS(bad), null, "numeric status must reject entire state");
});

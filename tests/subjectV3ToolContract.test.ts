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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSlotStateRepo(starts_at: string) {
  return {
    async loadState() { return { selected_slot: { starts_at } }; },
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
            requested_date: "2026-07-20",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Пожалуйста, уточните от чьего имени." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
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
            requested_date: "2026-07-20",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Записано!" } },
    ]),
    executors: {
      "booking.apply": async (ctx) => {
        capturedPhone = ctx.phone_number;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
  });

  const result = await loop.runTurn({
    ...BASE_TURN,
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(capturedPhone, TRUSTED_CONTACT.phone_number, "executor receives channel_contact phone for self-booking");
  assert.ok(!result.execution_subject_id, "no registry → execution_subject_id is null/undefined for single-subject");
});

// ── TC-3: subject_id=subject_2, no registry → registry bootstrapped ──────────

test("TC-3: subject_id=subject_2, no registry → registry bootstrapped via bootstrapRegistryFromBookingApplyArgs", async () => {
  const loop = createRuntimeAgentLoop({
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
            requested_date: "2026-07-20",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Анна записана." } },
    ]),
    executors: {
      "booking.apply": async () => ({
        status: "success" as const,
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
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
            requested_date: "2026-07-20",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Нужен subject_id." } },
    ]),
    executors: {
      "booking.apply": async () => {
        executorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
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
              requested_date: "2026-07-20",
              requested_time: "11:00",
            },
          }],
        },
        { type: "final_response", final_response: { final_patient_reply: "OK" } },
      ]),
      executors: {},
      bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
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
            requested_date: "2026-07-20",
            requested_time: "11:00",
          },
        }],
      },
      { type: "final_response", final_response: { final_patient_reply: "Рима записана." } },
    ]),
    executors: {
      "booking.apply": async (ctx) => {
        capturedPhone = ctx.phone_number;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
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
        slot: "2026-07-20T11:00", booking_contact: { phone_number: "+420123456789", source: "typed", trust: "unverified", owner_subject_id: "subject_2" as SubjectId, collected_at: null },
        status: "collecting", missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  const loop = createRuntimeAgentLoop({
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
            requested_date: "2026-07-20",
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
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true },
      }),
      "kb.search": async () => ({ status: "success" as const, data: { chunks: [] } }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
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
              requested_date: "2026-07-20",
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
        data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true },
      }),
    },
    bookingProcessStateRepository: makeSlotStateRepo("2026-07-20T11:00:00"),
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
  // Either the whole state is rejected (returns null) OR the booking_contact is nullified
  if (result !== null) {
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(
      s1?.booking_contact,
      null,
      "primitive booking_contact must be nullified during normalization",
    );
  }
  // result === null is also acceptable (strict rejection)
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
  // The state itself may normalize with subject_2's booking_contact set to null
  // because the shared phone doesn't match the owner's phone
  if (result !== null) {
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(
      s2?.booking_contact,
      null,
      "subject_2's booking_contact must be null when shared phone ≠ owner phone",
    );
  }
  // If normalizeBookingSubjectsState returns null entirely, that's also valid
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

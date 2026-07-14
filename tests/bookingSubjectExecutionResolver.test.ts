/**
 * PR #180 — BookingSubjectExecutionResolver + subjects v3 architectural fixes.
 *
 * Tests:
 * 1-5:  resolveBookingExecutionSubject unit tests
 * 6-8:  phone_ownership_intent propagation through return paths
 * 9-12: execution subject used for phone resolution in guards
 * 13-15: postUpdateBookingSubjects applies to frozen execution subject
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  resolveBookingExecutionSubject,
} from "../src/runtime/bookingSubjectExecutionResolver.ts";
import type { SubjectExecutionResolution } from "../src/runtime/bookingSubjectExecutionResolver.ts";
import {
  postUpdateBookingSubjects,
  normalizeBookingSubjectsState,
  buildSubjectsContextPayload,
} from "../src/runtime/bookingSubjectsState.ts";
import type {
  BookingSubjectsState,
  BookingSubject,
  BookingContact,
  SubjectId,
} from "../src/runtime/bookingSubjectsState.ts";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentTurnInput,
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeBC(
  phone: string,
  source: "telegram_contact_button" | "typed" | "whatsapp_sender" | "existing_cliniccard_patient" | "shared_from_subject",
  trust: "trusted" | "unverified" | "trusted_contact_owner",
  ownerId: SubjectId,
): BookingContact {
  return { phone_number: phone, source, trust, owner_subject_id: ownerId, collected_at: null };
}

function makeSubject(
  id: SubjectId,
  role: "sender" | "mentioned_person",
  overrides: Partial<Omit<BookingSubject, "id" | "role" | "missing">> = {},
): BookingSubject {
  const s: BookingSubject = {
    id, role, label: null, patient_name: null, service: null, slot: null, booking_contact: null, status: "collecting", missing: [],
    ...overrides,
  };
  const missing: string[] = [];
  if (!s.patient_name) missing.push("patient_name");
  if (!s.slot) missing.push("slot");
  if (!s.service) missing.push("service");
  if (!s.booking_contact) missing.push("booking_contact");
  s.missing = missing;
  return s;
}

function makeState(
  activeId: SubjectId,
  subjects: BookingSubject[],
  pendingPhone: string | null = null,
  status: "active" | "completed" = "active",
): BookingSubjectsState {
  return { version: 3, status, active_subject_id: activeId, subjects, pending_typed_phone: pendingPhone, max_subjects: 4 };
}

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

function makeFinalResponse(reply: string, extras: Record<string, unknown> = {}) {
  return {
    type: "final_response" as const,
    final_response: { final_patient_reply: reply, ...extras },
  };
}

function makeToolRequests(requests: RuntimeAgentToolRequest[]) {
  return { type: "tool_requests" as const, tool_requests: requests };
}

const BASE_INPUT: RuntimeAgentTurnInput = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  user_message: "Запишите",
  locale: "ru",
  trace_id: "trace_pr180",
  business_context: { channel: "telegram" },
};

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

// ── 1-5. resolveBookingExecutionSubject unit ──────────────────────────────────

describe("PR#180-1: resolveBookingExecutionSubject — subject_id required when registry active", () => {
  test("EXEC-1: no subject_id in args → subject_id_required conflict (no active_subject_id fallback)", () => {
    const state = makeState("subject_2" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender"),
      makeSubject("subject_2" as SubjectId, "mentioned_person"),
    ]);
    const result = resolveBookingExecutionSubject(state, { first_name: "Иван" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.booking_status, "subject_resolution_conflict");
      assert.equal(result.reason, "subject_id_required");
    }
  });

  test("EXEC-2: valid subject_id present → returns that subject_id", () => {
    const state = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender"),
      makeSubject("subject_2" as SubjectId, "mentioned_person"),
    ]);
    const result = resolveBookingExecutionSubject(state, { subject_id: "subject_2", first_name: "Иван" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.execution_subject_id, "subject_2");
  });

  test("EXEC-3: subject_id valid format but not in registry → subject_not_in_registry conflict", () => {
    const state = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender"),
    ]);
    // subject_3 is valid format but not present in this 1-subject registry
    const result = resolveBookingExecutionSubject(state, { subject_id: "subject_3" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.booking_status, "subject_resolution_conflict");
      assert.equal(result.reason, "subject_not_in_registry");
    }
  });

  test("EXEC-4: subject_id invalid format → subject_resolution_conflict", () => {
    const state = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender"),
    ]);
    const result = resolveBookingExecutionSubject(state, { subject_id: "invalid-id" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.booking_status, "subject_resolution_conflict");
      assert.equal(result.reason, "invalid_subject_id_format");
    }
  });

  test("EXEC-5: subject_id=null treated as absent → subject_id_required conflict (no fallback)", () => {
    const state = makeState("subject_2" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender"),
      makeSubject("subject_2" as SubjectId, "mentioned_person"),
    ]);
    const result = resolveBookingExecutionSubject(state, { subject_id: null });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.booking_status, "subject_resolution_conflict");
      assert.equal(result.reason, "subject_id_required");
    }
  });
});

// ── 6-8. phone_ownership_intent propagated through agent loop return paths ────

describe("PR#180-6: phone_ownership_intent propagated in all return paths", () => {
  test("EXEC-6: phone_ownership_intent from firstOutput (no tool calls) propagated in result", async () => {
    const loop = createRuntimeAgentLoop({
      model: "gpt-4o",
      caller: makeCallerSequence([
        makeFinalResponse("Чей этот номер?", {
          subject_intent: { action: "none", target: "active", confidence: "high" },
          phone_ownership_intent: { action: "assign_pending_phone", target_subject_id: "subject_2", confidence: "high" },
        }),
      ]),
      executors: {},
    });
    const result = await loop.runTurn({
      ...BASE_INPUT,
      channel_contact: TRUSTED_CONTACT,
    });
    assert.ok(result.phone_ownership_intent != null, "phone_ownership_intent must be propagated");
    assert.equal(result.phone_ownership_intent!.action, "assign_pending_phone");
    assert.equal(result.phone_ownership_intent!.target_subject_id, "subject_2");
  });

  test("EXEC-7: phone_ownership_intent from secondOutput (after tool) propagated in result", async () => {
    const loop = createRuntimeAgentLoop({
      model: "gpt-4o",
      caller: makeCallerSequence([
        makeToolRequests([{ tool: "kb.search", call_id: "kb_1", arguments: { query: "цены" } }]),
        makeFinalResponse("Вот цены.", {
          phone_ownership_intent: { action: "assign_pending_phone", target_subject_id: "subject_1", confidence: "medium" },
        }),
      ]),
      executors: {
        "kb.search": async () => ({ status: "success" as const, data: { chunks: [{ text: "Чистка 500 крон" }] } }),
      },
    });
    const result = await loop.runTurn({ ...BASE_INPUT });
    assert.ok(result.phone_ownership_intent != null);
    assert.equal(result.phone_ownership_intent!.action, "assign_pending_phone");
    assert.equal(result.phone_ownership_intent!.target_subject_id, "subject_1");
  });

  test("EXEC-8: phone_ownership_intent from guardedOutput (blocked booking.apply) propagated in result", async () => {
    // blocked booking.apply (missing trusted phone in single-subject mode) → finalizeBlocked
    // model emits phone_ownership_intent in the second guarded call
    const loop = createRuntimeAgentLoop({
      model: "gpt-4o",
      caller: makeCallerSequence([
        makeToolRequests([{
          tool: "booking.apply",
          call_id: "book_1",
          arguments: { first_name: "Иван", last_name: "Петров", service: "Чистка", requested_date: "2026-07-15", requested_time: "10:00" },
        }]),
        makeFinalResponse("Пожалуйста, поделитесь номером телефона.", {
          phone_ownership_intent: { action: "none", target_subject_id: null, confidence: "high" },
        }),
      ]),
      executors: {},
    });
    // No channel_contact → phone guard fires → finalizeBlockedBookingApplyWithToolOutput
    const result = await loop.runTurn({
      ...BASE_INPUT,
      // No provided_phone, no channel_contact → guard B fires
    });
    // The guard fires and calls finalizeBlocked with the guarded result
    assert.ok(result.phone_ownership_intent !== undefined, "phone_ownership_intent propagated from guarded path");
  });
});

// ── 9-12. Execution subject used for phone resolution in guards ────────────────

// Guard G (slot proof) fires before Guard J (subject resolution) and Guard I (pending phone).
// Bypass it by supplying a bookingProcessStateRepository with a matching selected_slot.
function makeSlotRepo(starts_at: string) {
  return {
    async loadState() { return { selected_slot: { starts_at } }; },
    async saveState() {},
  };
}

const SLOT_REPO = makeSlotRepo("2026-07-15T10:00:00");

describe("PR#180-9: subject_id in booking.apply args selects phone from correct subject", () => {
  const s2WithPhone = makeSubject("subject_2" as SubjectId, "mentioned_person", {
    patient_name: "Иван Петров",
    service: "Чистка",
    slot: "2026-07-15T10:00",
    booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2" as SubjectId),
  });

  test("EXEC-9: Guard B skips when resolved subject has phone even if active subject lacks one", async () => {
    // active=subject_1 (no phone). Guard J resolves execution subject to subject_2 (has phone).
    // Guard B must NOT fire — executor IS called.
    let bookingApplyCallCount = 0;
    const loop = createRuntimeAgentLoop({
      model: "gpt-4o",
      caller: makeCallerSequence([
        makeToolRequests([{
          tool: "booking.apply",
          call_id: "book_r1",
          arguments: {
            first_name: "Иван", last_name: "Петров",
            service: "Чистка", requested_date: "2026-07-15", requested_time: "10:00",
            subject_id: "subject_2",
          },
        }]),
        makeFinalResponse("Запись создана для Ивана."),
      ]),
      executors: {
        "booking.apply": async () => {
          bookingApplyCallCount++;
          return { status: "success" as const, data: { created_visit: true, booking_status: "visit_created", may_claim_booked: true } };
        },
      },
      bookingProcessStateRepository: SLOT_REPO,
    });
    const state = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender", { patient_name: "Рима" }), // no phone
      s2WithPhone,
    ]);
    await loop.runTurn({ ...BASE_INPUT, booking_subjects: state });
    assert.equal(bookingApplyCallCount, 1, "booking.apply must execute when resolved subject_2 has phone");
  });

  test("EXEC-10: round-2 booking.apply executor receives phone from resolved execution subject (not active)", async () => {
    // Round 1: model requests availability.check.
    // Round 2: model requests booking.apply with subject_id=subject_1 (active=subject_2).
    // buildExecutionContext at line 1016 passes round2ExecutionSubjectId=subject_1 →
    // executor gets subject_1's phone, not subject_2's.
    let executedPhone: string | undefined;
    const loop = createRuntimeAgentLoop({
      model: "gpt-4o",
      caller: makeCallerSequence([
        // Call 1 (round 1): model asks for availability
        makeToolRequests([{
          tool: "availability.check",
          call_id: "avail_1",
          arguments: { requested_date: "2026-07-15", requested_time: "10:00" },
        }]),
        // Call 2 (round 2): model asks to book for subject_1
        makeToolRequests([{
          tool: "booking.apply",
          call_id: "book_r2",
          arguments: {
            first_name: "Рима", last_name: "Кова",
            service: "Чистка", requested_date: "2026-07-15", requested_time: "10:00",
            subject_id: "subject_1",
          },
        }]),
        // Call 3: model produces final response after booking
        makeFinalResponse("Записала Риму."),
      ]),
      executors: {
        "availability.check": async () => ({
          tool: "availability.check" as const,
          status: "success" as const,
          data: { slots: [{ slot_id: "s1", starts_at: "2026-07-15T10:00:00", ends_at: "2026-07-15T10:30:00" }] },
        }),
        "booking.apply": async (ctx) => {
          executedPhone = ctx.phone_number;
          return { status: "success" as const, data: { created_visit: true, booking_status: "visit_created", may_claim_booked: true } };
        },
      },
    });
    const s1WithPhone = makeSubject("subject_1" as SubjectId, "sender", {
      patient_name: "Рима",
      booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1" as SubjectId),
    });
    const state = makeState("subject_2" as SubjectId, [s1WithPhone, s2WithPhone]);
    await loop.runTurn({ ...BASE_INPUT, booking_subjects: state });
    assert.equal(executedPhone, "+420724334616", "round-2 executor must receive subject_1 phone, not active subject_2 phone");
  });

  test("EXEC-11: Guard J round-1 returns subject_resolution_conflict for non-existent subject_id", async () => {
    // subject_id=subject_99 not in registry → Guard J fires and blocks with conflict status.
    let executorCalled = false;
    const loop = createRuntimeAgentLoop({
      model: "gpt-4o",
      caller: makeCallerSequence([
        makeToolRequests([{
          tool: "booking.apply",
          call_id: "book_r1",
          arguments: {
            first_name: "Иван", last_name: "Петров",
            service: "Чистка", requested_date: "2026-07-15", requested_time: "10:00",
            subject_id: "subject_99",
          },
        }]),
        makeFinalResponse("Не могу определить субъект."),
      ]),
      executors: {
        "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
      },
      bookingProcessStateRepository: SLOT_REPO,
    });
    const state = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender"),
      s2WithPhone,
    ]);
    const result = await loop.runTurn({ ...BASE_INPUT, booking_subjects: state });
    assert.equal(executorCalled, false, "executor must not run when subject not in registry");
    const applyResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(applyResult != null, "booking.apply synthetic result must appear in tool_results");
    const data = applyResult!.data as Record<string, unknown>;
    assert.equal(data.booking_status, "subject_resolution_conflict");
    assert.equal(data.created_visit, false);
  });

  test("EXEC-12: Guard I blocks booking.apply when pending_typed_phone present (fires after Guard J resolves)", async () => {
    // Guard J resolves subject_2 (valid), then Guard I fires because pending_typed_phone set.
    let executorCalled = false;
    const loop = createRuntimeAgentLoop({
      model: "gpt-4o",
      caller: makeCallerSequence([
        makeToolRequests([{
          tool: "booking.apply",
          call_id: "book_r1",
          arguments: {
            first_name: "Иван", last_name: "Петров",
            service: "Чистка", requested_date: "2026-07-15", requested_time: "10:00",
            subject_id: "subject_2",
          },
        }]),
        makeFinalResponse("Чей это номер?"),
      ]),
      executors: {
        "booking.apply": async () => { executorCalled = true; return { status: "success" as const, data: {} }; },
      },
      bookingProcessStateRepository: SLOT_REPO,
    });
    const stateWithPending = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender"),
      s2WithPhone,
    ], "+420728111222");
    const result = await loop.runTurn({ ...BASE_INPUT, booking_subjects: stateWithPending });
    assert.equal(executorCalled, false, "booking.apply must not execute when pending_typed_phone present");
    const applyResult = result.tool_results.find((r) => r.tool === "booking.apply");
    assert.ok(applyResult != null, "blocked booking.apply result must appear");
    const data = applyResult!.data as Record<string, unknown>;
    assert.equal(data.booking_status, "pending_phone_classification");
    assert.equal(data.created_visit, false);
  });
});

// ── 13-15. postUpdateBookingSubjects applies to frozen execution subject ────────

describe("PR#180-13: postUpdateBookingSubjects uses explicit executionSubjectId", () => {
  test("EXEC-13: booking result applied to executionSubjectId when different from active_subject_id", () => {
    const state = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender", { patient_name: "Рима" }),
      makeSubject("subject_2" as SubjectId, "mentioned_person", { patient_name: "Иван" }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", last_name: "Петров", requested_date: "2026-07-15", requested_time: "10:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
      executionSubjectId: "subject_2" as SubjectId,
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked", "subject_2 must be booked");
    assert.equal(s2?.patient_name, "Иван Петров");
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.status, "collecting", "subject_1 must be unchanged");
  });

  test("EXEC-14: status transitions to 'completed' when all subjects booked", () => {
    const state = makeState("subject_1" as SubjectId, [
      makeSubject("subject_1" as SubjectId, "sender", {
        patient_name: "Рима",
        service: "Чистка",
        slot: "2026-07-15T10:00",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1" as SubjectId),
        status: "booked",
      }),
      makeSubject("subject_2" as SubjectId, "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-15T11:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2" as SubjectId),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { requested_date: "2026-07-15", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
      executionSubjectId: "subject_2" as SubjectId,
    });
    assert.equal(updated.status, "completed", "all booked → status=completed");
  });

  test("EXEC-15: normalizeBookingSubjectsState coerces old episode_status to status + validates active_subject_id", () => {
    // Old persisted data with episode_status instead of status
    const oldState = {
      version: 3,
      episode_status: "completed",
      active_subject_id: "subject_1",
      subjects: [
        { id: "subject_1", role: "sender", patient_name: "Рима", service: null, slot: null, booking_contact: null, status: "booked", label: null, missing: [] },
      ],
      pending_typed_phone: null,
    };
    const result = normalizeBookingSubjectsState(oldState);
    assert.ok(result !== null, "must parse successfully");
    assert.equal(result!.status, "completed", "episode_status coerced to status");
    assert.equal(result!.version, 3);
    // active_subject_id must reference an existing subject
    const hasActiveSubject = result!.subjects.some((s) => s.id === result!.active_subject_id);
    assert.ok(hasActiveSubject, "active_subject_id must reference existing subject");
    // buildSubjectsContextPayload must not include episode fields
    const payload = buildSubjectsContextPayload(result!);
    assert.ok(!("episode_id" in payload), "no episode_id in payload");
    assert.ok(!("episode_status" in payload), "no episode_status in payload");
    assert.equal(payload.status, "completed");
  });
});

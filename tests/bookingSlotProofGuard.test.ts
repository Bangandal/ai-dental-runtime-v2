/**
 * PR #163 — booking.apply requires selected_slot proof.
 * PR #184 — updated to use authoritative evidence-based proof (validateBookingSlotEvidence).
 *
 * Guard G: booking.apply may proceed only when there is verified slot proof —
 * either a current-turn authoritative availability.check result covering the requested
 * date+time, or a persisted selected_slot with a matching selected_slot_proof and
 * active_availability_evidence. Without proof, booking.apply is blocked with
 * booking_status: "slot_not_verified".
 *
 * 5 unit tests (shouldInterceptMissingSlotProof) + 3 integration tests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { shouldInterceptMissingSlotProof } from "../src/runtime/bookingApplyPreflight.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  ChannelContact,
} from "../src/runtime/openaiRuntimeAgent.ts";
import type { AvailableSlot } from "../src/runtime/bookingProcessState.ts";
import type { AuthoritativeAvailabilityAttempt } from "../src/runtime/availabilityActionTruth.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "../src/runtime/slotEvidence.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+380991350135",
  phone_source: "telegram_contact_button",
};

const SLOT: AvailableSlot = {
  starts_at: "2026-07-09T12:00:00",
  ends_at: "2026-07-09T12:30:00",
  slot_id: "2026-07-09T12:00",
};

const BOOKING_APPLY_FULL: RuntimeAgentToolRequest = {
  tool: "booking.apply",
  call_id: "call_bk_1",
  arguments: {
    subject_id: "subject_1",
    first_name: "Роман",
    last_name: "Анбасадоров",
    service: "чистка",
    requested_date: "2026-07-09",
    requested_time: "12:00",
  },
};

const AVAIL_REQUEST: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_av_1",
  arguments: { requested_date: "2026-07-09" },
};

const AVAILABILITY_SUCCESS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_av_1",
  status: "success",
  data: { slots: [{ starts_at: "2026-07-09T12:00:00", ends_at: "2026-07-09T12:30:00" }], total_slots: 1, free_slots_count: 1 },
};

const AVAILABILITY_FAILED: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_av_2",
  status: "failed",
  error: { code: "adapter_error", message: "timeout" },
};

const NO_ATTEMPT: AuthoritativeAvailabilityAttempt = { attempted: false, request: null, pair: null };

const SUCCESS_ATTEMPT: AuthoritativeAvailabilityAttempt = {
  attempted: true,
  request: AVAIL_REQUEST,
  pair: { request: AVAIL_REQUEST, result: AVAILABILITY_SUCCESS },
};

const EVIDENCE: AvailabilityEvidence = {
  availability_call_id: "call_av_1",
  requested_date: "2026-07-09",
  requested_time: null,
  allowed_slot_keys: ["2026-07-09T12:00"],
};

const SLOT_PROOF: SelectedSlotProof = {
  subject_id: "subject_1" as const,
  availability_call_id: "call_av_1",
  slot_key: "2026-07-09T12:00",
};

const BASE_TURN_INPUT = {
  clinic_id: "clinic_1",
  contact_id: "contact_1",
  case_id: null,
  user_message: "Да, запишите меня",
  locale: "ru",
  trace_id: "trace_pr163",
};

function makeCallerSequence(outputs: Awaited<ReturnType<RuntimeAgentCaller>>[]): RuntimeAgentCaller {
  let call = 0;
  return async () => outputs[call++] ?? outputs[outputs.length - 1];
}

// ── Unit: shouldInterceptMissingSlotProof ─────────────────────────────────────

test("BSPG-1: intercepts when no availability evidence and no selectedSlot", () => {
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      currentAvailabilityAttempt: NO_ATTEMPT,
      activeAvailabilityEvidence: null,
      selectedSlot: null,
    }),
    true,
  );
});

test("BSPG-2: intercepts when only current-turn avail.check present — no select_slot proof", () => {
  // Removed current-turn bypass: availability.check alone never authorizes booking.apply.
  // Model must call booking.select_slot to create proof; without it, guard fires regardless.
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      activeAvailabilityEvidence: null,
      selectedSlot: null,
    }),
    true,
  );
});

test("BSPG-3: does NOT intercept when selectedSlot has valid proof matching requested date+time", () => {
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      currentAvailabilityAttempt: NO_ATTEMPT,
      activeAvailabilityEvidence: EVIDENCE,
      selectedSlot: SLOT,
      selectedSlotProof: SLOT_PROOF,
    }),
    false,
  );
});

test("BSPG-4: intercepts when selectedSlot date mismatches requested_date (proof key mismatch)", () => {
  const wrongDateSlot: AvailableSlot = { starts_at: "2026-07-10T12:00:00" };
  const wrongProof: SelectedSlotProof = { availability_call_id: "call_av_1", slot_key: "2026-07-10T12:00" };
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      currentAvailabilityAttempt: NO_ATTEMPT,
      activeAvailabilityEvidence: EVIDENCE,
      selectedSlot: wrongDateSlot,
      selectedSlotProof: wrongProof,
    }),
    true,
  );
});

test("BSPG-5: intercepts when selectedSlot time mismatches requested_time (proof key mismatch)", () => {
  const wrongTimeSlot: AvailableSlot = { starts_at: "2026-07-09T14:00:00" };
  const wrongProof: SelectedSlotProof = { availability_call_id: "call_av_1", slot_key: "2026-07-09T14:00" };
  assert.equal(
    shouldInterceptMissingSlotProof({
      pendingToolRequests: [BOOKING_APPLY_FULL],
      currentAvailabilityAttempt: NO_ATTEMPT,
      activeAvailabilityEvidence: EVIDENCE,
      selectedSlot: wrongTimeSlot,
      selectedSlotProof: wrongProof,
    }),
    true,
  );
});

// ── Integration: round-2, no avail.check → slot_not_verified ─────────────────

test("BSPG-6: round-2 booking.apply with no avail.check result → slot_not_verified, executor not called", async () => {
  let bookingExecutorCalled = false;

  // Sequence: round-1 model requests kb.search (not avail.check), then round-2 requests
  // booking.apply directly — no avail.check was done in this turn.
  const KB_REQUEST: RuntimeAgentToolRequest = {
    tool: "kb.search" as any,
    call_id: "call_kb_1",
    arguments: { query: "цена чистки" },
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bspg6",
        tool_requests: [KB_REQUEST],
      },
      {
        type: "tool_requests",
        conversation_id: "conv_bspg6",
        tool_requests: [BOOKING_APPLY_FULL],
      },
      {
        type: "final_response",
        conversation_id: "conv_bspg6",
        final_response: { final_patient_reply: "Сначала проверим доступное время — на какую дату удобно?" },
      },
    ]),
    executors: {
      "kb.search": async () => ({
        status: "success" as const,
        data: { chunks: [{ text: "Чистка — 1500 Kč" }] },
      }),
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bspg6",
    channel_contact: TRUSTED_CONTACT,
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called without slot proof");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "slot_not_verified",
    "booking_status must be slot_not_verified",
  );
  assert.equal((bookingResult!.data as Record<string, unknown>).created_visit, false);
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_slot_proof_round2",
  );
});

// ── Integration: round-1, no selectedSlot → slot_not_verified ────────────────

test("BSPG-7: round-1 booking.apply with all fields but no slot proof → slot_not_verified, executor not called", async () => {
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bspg7",
        tool_requests: [BOOKING_APPLY_FULL],
      },
      {
        type: "final_response",
        conversation_id: "conv_bspg7",
        final_response: { final_patient_reply: "Давайте сначала проверим доступные слоты." },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bspg7",
    channel_contact: TRUSTED_CONTACT,
    // No bookingProcessStateRepository → no selectedSlot from prior state
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called without slot proof");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "slot_not_verified",
    "booking_status must be slot_not_verified",
  );
  assert.equal((bookingResult!.data as Record<string, unknown>).created_visit, false);
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_slot_proof_round1",
  );
});

// ── Integration: phone guard has priority over slot proof guard ───────────────

test("BSPG-8: slot proof guard fires before phone guard — missing phone + no avail.check → slot_not_verified, not missing_trusted_phone", async () => {
  // PR #167: guard order changed. Slot proof (G) fires before phone (A) so invalid/unverified
  // slots are caught before asking for the patient's contact. Round-1 booking.apply with full
  // fields but no avail.check proof → slot_not_verified must fire, not missing_trusted_phone.
  let bookingExecutorCalled = false;

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller: makeCallerSequence([
      {
        type: "tool_requests",
        conversation_id: "conv_bspg8",
        tool_requests: [BOOKING_APPLY_FULL],
      },
      {
        type: "final_response",
        conversation_id: "conv_bspg8",
        final_response: { final_patient_reply: "Сначала проверим доступное время — на какую дату удобно?" },
      },
    ]),
    executors: {
      "booking.apply": async () => {
        bookingExecutorCalled = true;
        return { status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
  });

  const result = await loop.runTurn({
    ...BASE_TURN_INPUT,
    conversation_id: "conv_bspg8",
    channel_contact: undefined, // no phone
  });

  assert.equal(bookingExecutorCalled, false, "booking.apply executor must NOT be called");

  const bookingResult = result.tool_results.find((r) => r.tool === "booking.apply");
  assert.ok(bookingResult, "guarded booking.apply result must appear in tool_results");
  assert.equal(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "slot_not_verified",
    "slot proof guard must fire before phone guard",
  );
  assert.notEqual(
    (bookingResult!.data as Record<string, unknown>).booking_status,
    "missing_trusted_phone",
    "phone guard must NOT fire before slot proof guard",
  );
  assert.equal(
    (result.debug as Record<string, unknown>)?.reason,
    "booking_apply_preflight_missing_slot_proof_round1",
  );
});

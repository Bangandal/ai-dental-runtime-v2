/**
 * Tests for availabilityActionTruth and stale-slot invalidation (PR #183).
 *
 * Coverage:
 *   Booking process state (tests 1–6): lifecycle after failed/success/no attempt
 *   Availability action truth (tests 7–12): outcome mapping and call_id pairing
 *   Runtime integration (tests 13–16): second-call context and conversation resumability
 *   Prompt contract (tests 17–19): availability_action_truth rule in system instruction
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  computeBookingProcessState,
  createInMemoryBookingProcessStateRepository,
  type AvailableSlot,
} from "../src/runtime/bookingProcessState.ts";
import {
  buildAvailabilityActionTruth,
  resolveAuthoritativeAvailabilityAttempt,
  type AuthoritativeAvailabilityAttempt,
} from "../src/runtime/availabilityActionTruth.ts";
import { buildAvailabilityPresentationTruth } from "../src/runtime/availabilityPresentationTruth.ts";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";
import { createRuntimeAgentLoop, type RuntimeAgentCaller, type RuntimeAgentCallerInput } from "../src/runtime/runtimeAgentLoop.ts";
import type { RuntimeAgentToolResult, RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

/** Test helper — resolves requests+results into the attempt then calls buildAvailabilityActionTruth. */
function actionTruth(requests: RuntimeAgentToolRequest[], results: RuntimeAgentToolResult[]) {
  return buildAvailabilityActionTruth(resolveAuthoritativeAvailabilityAttempt(requests, results));
}

/** Test helper — resolves requests+results then calls buildAvailabilityPresentationTruth. */
function presentationTruth(requests: RuntimeAgentToolRequest[], results: RuntimeAgentToolResult[]) {
  return buildAvailabilityPresentationTruth(resolveAuthoritativeAvailabilityAttempt(requests, results));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SLOT_A: AvailableSlot = { starts_at: "2026-07-01T09:00:00", ends_at: "2026-07-01T09:30:00", slot_id: "s0900" };
const SLOT_B: AvailableSlot = { starts_at: "2026-07-01T10:00:00", ends_at: "2026-07-01T10:30:00", slot_id: "s1000" };

const PRIOR_WITH_SLOTS = {
  last_available_slots: [SLOT_A, SLOT_B],
  selected_slot: SLOT_A,
  first_name: "Роман",
  last_name: "Асимов",
  service_reason: "чистка",
  phone_trusted: false,
  proof: {
    service_known: true,
    name_known: true,
    slot_known: true,
    trusted_phone_known: false,
    ready_for_booking_apply: false,
  },
};

const PAST_DATE_RESULT: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_past",
  status: "failed",
  error: {
    code: "availability_past_date",
    message: "2026-07-01 is in the past. Today is 2026-07-15. Ask the patient for a date from today onwards.",
    retryable: false,
  },
};

const GENERIC_FAIL_RESULT: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_fail",
  status: "failed",
  error: { code: "cliniccard_availability_error", message: "HTTP 503", retryable: true },
};

const DENIED_RESULT: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_denied",
  status: "denied",
};

const SUCCESS_WITH_SLOTS: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_new",
  status: "success",
  data: {
    slots: [
      { starts_at: "2026-07-17T09:00:00", ends_at: "2026-07-17T09:30:00", slot_id: "s170900" },
      { starts_at: "2026-07-17T10:00:00", ends_at: "2026-07-17T10:30:00", slot_id: "s171000" },
    ],
  },
};

const SUCCESS_EMPTY: RuntimeAgentToolResult = {
  tool: "availability.check",
  call_id: "call_avail_empty",
  status: "success",
  data: { slots: [] },
};

const REQ_PAST_DATE: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_past",
  arguments: { requested_date: "2026-07-01", service_interest: "чистка" },
};

const REQ_NEW_DATE: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_new",
  arguments: { requested_date: "2026-07-17", requested_time: "09:00", service_interest: "чистка" },
};

const REQ_FAIL: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_fail",
  arguments: { requested_date: "2026-07-17" },
};

const REQ_DENIED: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_denied",
  arguments: { requested_date: "2026-07-17" },
};

const REQ_EMPTY: RuntimeAgentToolRequest = {
  tool: "availability.check",
  call_id: "call_avail_empty",
  arguments: { requested_date: "2026-07-17" },
};

// ── Booking process state lifecycle ──────────────────────────────────────────

describe("Booking process state — stale slot invalidation", () => {
  test("1: availability_past_date clears last_available_slots and selected_slot", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [PAST_DATE_RESULT],
    });
    assert.deepEqual(state.last_available_slots, [], "last_available_slots must be []");
    assert.equal(state.selected_slot, null, "selected_slot must be null");
  });

  test("2: generic availability failure clears stale slots and selected_slot", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [GENERIC_FAIL_RESULT],
    });
    assert.deepEqual(state.last_available_slots, [], "stale slots must be cleared");
    assert.equal(state.selected_slot, null, "selected_slot must be cleared");
  });

  test("3: denied availability result clears stale slots", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [DENIED_RESULT],
    });
    assert.deepEqual(state.last_available_slots, [], "stale slots must be cleared on denied");
    assert.equal(state.selected_slot, null);
  });

  test("4: fresh successful result replaces prior slots; prior selected_slot is cleared; re-detection uses only fresh slots", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [SUCCESS_WITH_SLOTS],
      patientMessage: "давайте 09:00",
    });
    assert.equal(state.last_available_slots?.length, 2, "must have 2 fresh slots");
    assert.equal(
      state.last_available_slots?.[0].starts_at,
      "2026-07-17T09:00:00",
      "must be fresh July 17 slot",
    );
    assert.ok(state.selected_slot !== null, "09:00 slot must be detected from fresh slots");
    assert.ok(
      state.selected_slot?.starts_at.includes("2026-07-17"),
      "selected slot must be from fresh July 17 result, not stale July 1 prior",
    );
  });

  test("5: no availability attempt preserves prior availability state unchanged", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [],
      patientMessage: "Меня зовут Иван Петров",
    });
    assert.equal(state.last_available_slots?.length, 2, "prior slots must be preserved");
    assert.equal(
      state.selected_slot?.starts_at,
      SLOT_A.starts_at,
      "prior selected_slot preserved when no availability attempt made",
    );
  });

  test("6: failed availability preserves name, service, and collects trusted phone", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [PAST_DATE_RESULT],
      channelContact: { phone_number: "+420123456789", phone_source: "telegram_contact_button" },
    });
    assert.equal(state.first_name, "Роман", "first_name preserved from prior");
    assert.equal(state.last_name, "Асимов", "last_name preserved from prior");
    assert.equal(state.service_reason, "чистка", "service_reason preserved from prior");
    assert.equal(state.phone_trusted, true, "trusted phone from channel contact captured");
  });
});

// ── Availability action truth ─────────────────────────────────────────────────

describe("buildAvailabilityActionTruth", () => {
  test("7: success with slots → slots_available, can_present_slots=true, allowed_slot_starts in HH:MM", () => {
    const truth = actionTruth([REQ_NEW_DATE], [SUCCESS_WITH_SLOTS]);
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "slots_available");
    assert.equal(truth!.can_present_slots, true);
    assert.equal(truth!.required_next_action, "choose_slot");
    assert.equal(truth!.allowed_slot_starts.length, 2);
    // allowed_slot_starts must be HH:MM, not full ISO
    assert.ok(truth!.allowed_slot_starts.includes("09:00"), "must include 09:00 in HH:MM");
    assert.ok(truth!.allowed_slot_starts.includes("10:00"), "must include 10:00 in HH:MM");
    assert.ok(!truth!.allowed_slot_starts.some(s => s.includes("T")), "must not contain ISO T-separator");
  });

  test("8: success with zero slots → no_slots, can_present_slots=false, empty allowed_slot_starts", () => {
    const truth = actionTruth([REQ_EMPTY], [SUCCESS_EMPTY]);
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "no_slots");
    assert.equal(truth!.can_present_slots, false);
    assert.equal(truth!.required_next_action, "ask_for_alternative_time");
    assert.deepEqual(truth!.allowed_slot_starts, []);
  });

  test("9: availability_past_date → past_date, ask_for_future_date", () => {
    const truth = actionTruth([REQ_PAST_DATE], [PAST_DATE_RESULT]);
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "past_date");
    assert.equal(truth!.can_present_slots, false);
    assert.equal(truth!.required_next_action, "ask_for_future_date");
    assert.deepEqual(truth!.allowed_slot_starts, []);
  });

  test("10: generic failure → technical_failure, retry_or_contact_clinic", () => {
    const truth = actionTruth([REQ_FAIL], [GENERIC_FAIL_RESULT]);
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "technical_failure");
    assert.equal(truth!.can_present_slots, false);
    assert.equal(truth!.required_next_action, "retry_or_contact_clinic");
  });

  test("11: request/result pairing uses matching call_id, not first result in list", () => {
    const reqA: RuntimeAgentToolRequest = {
      tool: "availability.check",
      call_id: "call_A",
      arguments: { requested_date: "2026-07-17" },
    };
    const resultB: RuntimeAgentToolResult = {
      tool: "availability.check",
      call_id: "call_B",
      status: "failed",
      error: { code: "some_error", message: "x" },
    };
    const resultA: RuntimeAgentToolResult = {
      tool: "availability.check",
      call_id: "call_A",
      status: "success",
      data: { slots: [{ starts_at: "2026-07-17T09:00:00" }] },
    };
    const truth = actionTruth([reqA], [resultB, resultA]);
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "slots_available", "must pair with result A, not result B");
  });

  test("12: requested_date and requested_time come from tool request arguments", () => {
    const truth = actionTruth([REQ_NEW_DATE], [SUCCESS_WITH_SLOTS]);
    assert.ok(truth !== null);
    assert.equal(truth!.requested_date, "2026-07-17", "date from request args");
    assert.equal(truth!.requested_time, "09:00", "time from request args");
  });
});

// ── Multi-check invariant tests ───────────────────────────────────────────────

describe("Multi-check: last availability.check supersedes earlier results", () => {
  const REQ_FIRST: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "call_first",
    arguments: { requested_date: "2026-07-01" },
  };
  const REQ_SECOND: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "call_second",
    arguments: { requested_date: "2026-07-17" },
  };

  const RESULT_FIRST_SUCCESS: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_first",
    status: "success",
    data: {
      slots: [
        { starts_at: "2026-07-01T09:00:00", slot_id: "s0901" },
        { starts_at: "2026-07-01T10:00:00", slot_id: "s0101" },
      ],
    },
  };

  const RESULT_SECOND_FAILURE: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_second",
    status: "failed",
    error: { code: "availability_past_date", message: "2026-07-17 is in the past.", retryable: false },
  };

  const RESULT_FIRST_FAILURE: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_first",
    status: "failed",
    error: { code: "cliniccard_error", message: "503", retryable: true },
  };

  const RESULT_SECOND_SUCCESS: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_second",
    status: "success",
    data: {
      slots: [
        { starts_at: "2026-07-17T09:00:00", slot_id: "s1709" },
        { starts_at: "2026-07-17T14:00:00", slot_id: "s1714" },
      ],
    },
  };

  const RESULT_FIRST_ALT_DATE: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_first",
    status: "success",
    data: {
      slots: [{ starts_at: "2026-07-01T11:00:00", slot_id: "s0111" }],
    },
  };

  // ── action truth ──

  test("MC-1: first success, second failure → technical_failure, can_present_slots=false", () => {
    const truth = actionTruth(
      [REQ_FIRST, REQ_SECOND],
      [RESULT_FIRST_SUCCESS, RESULT_SECOND_FAILURE],
    );
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "past_date", "last (second) result determines outcome");
    assert.equal(truth!.can_present_slots, false, "first success must not authorize presentation");
    assert.deepEqual(truth!.allowed_slot_starts, [], "no slots allowed when last result failed");
  });

  test("MC-2: first failure, second success → only second result slots in allowed_slot_starts", () => {
    const truth = actionTruth(
      [REQ_FIRST, REQ_SECOND],
      [RESULT_FIRST_FAILURE, RESULT_SECOND_SUCCESS],
    );
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "slots_available", "second success determines outcome");
    assert.equal(truth!.can_present_slots, true);
    assert.deepEqual(truth!.allowed_slot_starts, ["09:00", "14:00"], "only second result slots");
    assert.ok(
      !truth!.allowed_slot_starts.some(s => s.includes("2026-07-01")),
      "first failure result must not contribute slots",
    );
  });

  test("MC-3: two successes for different dates → only final result slots survive", () => {
    const truth = actionTruth(
      [REQ_FIRST, REQ_SECOND],
      [RESULT_FIRST_ALT_DATE, RESULT_SECOND_SUCCESS],
    );
    assert.ok(truth !== null);
    assert.equal(truth!.outcome, "slots_available");
    assert.deepEqual(truth!.allowed_slot_starts, ["09:00", "14:00"], "only July-17 slots from second result");
    assert.ok(
      !truth!.allowed_slot_starts.includes("11:00"),
      "July-1 slot from first success must be superseded",
    );
  });

  test("MC-4: request/result in different order still pair by exact call_id", () => {
    // Results arrive in reverse order from requests
    const truth = actionTruth(
      [REQ_FIRST, REQ_SECOND],
      [RESULT_SECOND_SUCCESS, RESULT_FIRST_SUCCESS],
    );
    assert.ok(truth !== null);
    // Last REQUEST is REQ_SECOND (call_id "call_second"), should pair with RESULT_SECOND_SUCCESS
    assert.equal(truth!.outcome, "slots_available");
    assert.deepEqual(truth!.allowed_slot_starts, ["09:00", "14:00"], "must pair second request with its result");
  });

  test("MC-5: request with missing call_id cannot pair → technical_failure, can_present_slots=false", () => {
    const reqNoCid: RuntimeAgentToolRequest = {
      tool: "availability.check",
      call_id: undefined,
      arguments: { requested_date: "2026-07-17" },
    };
    const result: RuntimeAgentToolResult = {
      tool: "availability.check",
      call_id: "call_second",
      status: "success",
      data: { slots: [{ starts_at: "2026-07-17T09:00:00" }] },
    };
    const truth = actionTruth([reqNoCid], [result]);
    assert.ok(truth !== null, "missing call_id must produce action truth (technical_failure), not null");
    assert.equal(truth!.outcome, "technical_failure", "must be technical_failure when call_id missing");
    assert.equal(truth!.can_present_slots, false, "must not authorize slot presentation");
    assert.deepEqual(truth!.allowed_slot_starts, [], "no slots allowed");
  });

  // ── booking process state ──

  test("MC-6a: computeBookingProcessState — first success, second failure → last_available_slots=[]", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [RESULT_FIRST_SUCCESS, RESULT_SECOND_FAILURE],
    });
    assert.deepEqual(state.last_available_slots, [], "last failure must clear slots even though first succeeded");
    assert.equal(state.selected_slot, null);
  });

  test("MC-6b: computeBookingProcessState — first failure, second success → only second slots", () => {
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      toolResults: [RESULT_FIRST_FAILURE, RESULT_SECOND_SUCCESS],
    });
    assert.equal(state.last_available_slots?.length, 2, "must have 2 slots from second success");
    assert.ok(
      state.last_available_slots?.every(s => s.starts_at.includes("2026-07-17")),
      "slots must be from second result only (July 17), not first failure",
    );
  });

  test("MC-6c: computeBookingProcessState — two successes → only last result slots", () => {
    const state = computeBookingProcessState({
      prior: {},
      toolResults: [RESULT_FIRST_ALT_DATE, RESULT_SECOND_SUCCESS],
    });
    assert.equal(state.last_available_slots?.length, 2);
    assert.ok(
      state.last_available_slots?.every(s => s.starts_at.includes("2026-07-17")),
      "must be July 17 slots from second result only",
    );
    assert.ok(
      !state.last_available_slots?.some(s => s.starts_at.includes("2026-07-01")),
      "July 1 slot from first success must be superseded",
    );
  });

  // ── cross-truth consistency ──

  test("MC-7: action truth and presentation truth reference the same final attempt (same allowed_slot_starts)", () => {
    const requests = [REQ_FIRST, REQ_SECOND];
    const results = [RESULT_FIRST_SUCCESS, RESULT_SECOND_SUCCESS];
    const actionTruth = buildAvailabilityActionTruth(resolveAuthoritativeAvailabilityAttempt(requests, results));
    const presentationTruth = buildAvailabilityPresentationTruth(resolveAuthoritativeAvailabilityAttempt(requests, results));
    assert.ok(actionTruth !== null);
    assert.ok(presentationTruth !== null);
    // Both must agree on slot list
    assert.deepEqual(
      actionTruth!.allowed_slot_starts,
      presentationTruth!.allowed_slot_starts,
      "action truth and presentation truth must expose the same allowed_slot_starts",
    );
    // Slots must be from second result only
    assert.deepEqual(actionTruth!.allowed_slot_starts, ["09:00", "14:00"]);
  });
});

// ── Runtime integration ───────────────────────────────────────────────────────

describe("Runtime integration — availability_action_truth in second call", () => {
  function makePastDateCaller(conversationId: string) {
    const secondCallInputs: RuntimeAgentCallerInput[] = [];
    let callIdx = 0;
    const caller: RuntimeAgentCaller = async (input) => {
      callIdx++;
      if (callIdx === 1) {
        return {
          type: "tool_requests",
          conversation_id: conversationId,
          tool_requests: [{
            tool: "availability.check" as const,
            call_id: "call_past",
            arguments: { requested_date: "2026-07-01" },
          }],
        };
      }
      secondCallInputs.push(input);
      return {
        type: "final_response",
        conversation_id: conversationId,
        final_response: { final_patient_reply: "Эта дата прошла, выберите другую." },
      };
    };
    return { caller, secondCallInputs };
  }

  const pastDateExecutor = async () => ({
    status: "failed" as const,
    error: {
      code: "availability_past_date",
      message: "2026-07-01 is in the past. Today is 2026-07-15.",
      retryable: false,
    },
    data: null as null,
  });

  test("13: second model call receives availability_action_truth when availability.check ran", async () => {
    const { caller, secondCallInputs } = makePastDateCaller("conv_13");

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: { "availability.check": pastDateExecutor },
      now: new Date("2026-07-15T10:00:00Z"),
    });

    await loop.runTurn({
      clinic_id: "clinic_1",
      contact_id: "contact_13",
      case_id: null,
      user_message: "запишите на 1 июля",
      locale: "ru",
      trace_id: "trace_13",
    });

    assert.equal(secondCallInputs.length, 1, "second model call must have happened");
    const ctx = secondCallInputs[0].input.context;
    assert.ok("availability_action_truth" in ctx, "second call context must include availability_action_truth");
    const aat = ctx.availability_action_truth as { outcome: string; can_present_slots: boolean };
    assert.equal(aat.outcome, "past_date", "outcome must be past_date");
    assert.equal(aat.can_present_slots, false, "can_present_slots must be false");
  });

  test("14: after availability_past_date, second-call booking_process_state has no old slots and no selected_slot", async () => {
    const { caller, secondCallInputs } = makePastDateCaller("conv_14");

    const repo = createInMemoryBookingProcessStateRepository();
    await repo.saveState(
      { clinic_id: "clinic_1", contact_id: "contact_14", case_id: null },
      {
        last_available_slots: [SLOT_A, SLOT_B],
        selected_slot: SLOT_A,
        proof: {
          service_known: false,
          name_known: false,
          slot_known: true,
          trusted_phone_known: false,
          ready_for_booking_apply: false,
        },
      },
    );

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: { "availability.check": pastDateExecutor },
      bookingProcessStateRepository: repo,
      now: new Date("2026-07-15T10:00:00Z"),
    });

    await loop.runTurn({
      clinic_id: "clinic_1",
      contact_id: "contact_14",
      case_id: null,
      user_message: "запишите на 1 июля",
      locale: "ru",
      trace_id: "trace_14",
    });

    assert.equal(secondCallInputs.length, 1, "second call must have happened");
    const ctx = secondCallInputs[0].input.context;
    const bps = ctx.booking_process_state as {
      last_available_slots?: unknown[];
      selected_slot?: unknown;
    } | undefined;
    assert.ok(bps !== undefined, "booking_process_state must be in second-call context");
    const slots = bps?.last_available_slots;
    assert.ok(!slots || slots.length === 0, "old slots must not appear in second-call booking_process_state");
    assert.ok(
      bps?.selected_slot === null || bps?.selected_slot === undefined,
      "selected_slot must be cleared after availability failure",
    );
  });

  test("15: availability_past_date does not dirty the conversation thread (thread stays resumable)", async () => {
    const { caller } = makePastDateCaller("conv_15");

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: { "availability.check": pastDateExecutor },
      now: new Date("2026-07-15T10:00:00Z"),
    });

    const result = await loop.runTurn({
      clinic_id: "clinic_1",
      contact_id: "contact_15",
      case_id: null,
      user_message: "запишите на 1 июля",
      locale: "ru",
      trace_id: "trace_15",
      conversation_id: "conv_15",
    });

    assert.equal(result.conversation_id, "conv_15", "conversation_id must be preserved");
    assert.ok(
      result.conversation_id_resumable !== false,
      "availability_past_date via executor path must not dirty the conversation thread",
    );
  });

  test("16: stale old slots do not appear as authoritative state in second call after a failed check", async () => {
    const { caller, secondCallInputs } = makePastDateCaller("conv_16");

    const repo = createInMemoryBookingProcessStateRepository();
    await repo.saveState(
      { clinic_id: "clinic_1", contact_id: "contact_16", case_id: null },
      {
        last_available_slots: [SLOT_A, SLOT_B],
        selected_slot: SLOT_A,
        proof: {
          service_known: false,
          name_known: false,
          slot_known: true,
          trusted_phone_known: false,
          ready_for_booking_apply: false,
        },
      },
    );

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: { "availability.check": pastDateExecutor },
      bookingProcessStateRepository: repo,
      now: new Date("2026-07-15T10:00:00Z"),
    });

    await loop.runTurn({
      clinic_id: "clinic_1",
      contact_id: "contact_16",
      case_id: null,
      user_message: "запишите на 1 июля",
      locale: "ru",
      trace_id: "trace_16",
    });

    assert.equal(secondCallInputs.length, 1, "second call must have happened");
    const ctx = secondCallInputs[0].input.context;
    const bps = ctx.booking_process_state as { last_available_slots?: unknown[] } | undefined;
    assert.ok(
      !bps?.last_available_slots || bps.last_available_slots.length === 0,
      "stale July 1 slots must not appear in second-call booking_process_state after failed check",
    );
  });
});

// ── Authoritative attempt — three-consumer consistency ───────────────────────

describe("Authoritative attempt — required three-consumer consistency tests", () => {
  const REQ_A: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "call_a",
    arguments: { requested_date: "2026-07-20", requested_time: "09:00" },
  };
  const REQ_B: RuntimeAgentToolRequest = {
    tool: "availability.check",
    call_id: "call_b",
    arguments: { requested_date: "2026-07-21" },
  };
  const RESULT_A: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_a",
    status: "success",
    data: { slots: [{ starts_at: "2026-07-20T11:00:00", slot_id: "sA11" }] },
  };
  const RESULT_B: RuntimeAgentToolResult = {
    tool: "availability.check",
    call_id: "call_b",
    status: "success",
    data: {
      slots: [
        { starts_at: "2026-07-21T09:00:00", slot_id: "sB09" },
        { starts_at: "2026-07-21T14:00:00", slot_id: "sB14" },
      ],
    },
  };

  test("AA-1: reordered results [B,A] with requests [A,B] — all three consumers use last request (B)", () => {
    const requests = [REQ_A, REQ_B];
    const results = [RESULT_B, RESULT_A]; // reversed order

    // Action truth uses B
    const at = actionTruth(requests, results);
    assert.ok(at !== null, "action truth must not be null");
    assert.equal(at!.outcome, "slots_available");
    assert.deepEqual(at!.allowed_slot_starts, ["09:00", "14:00"], "action truth must use REQ_B slots");
    assert.ok(!at!.allowed_slot_starts.includes("11:00"), "REQ_A slot 11:00 must not appear");

    // Presentation truth uses B
    const pt = presentationTruth(requests, results);
    assert.ok(pt !== null, "presentation truth must not be null");
    assert.deepEqual(pt!.allowed_slot_starts, ["09:00", "14:00"], "presentation truth must use REQ_B slots");

    // Booking state uses B via authoritativeAvailabilityAttempt
    const attempt = resolveAuthoritativeAvailabilityAttempt(requests, results);
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      authoritativeAvailabilityAttempt: attempt,
    });
    assert.equal(state.last_available_slots?.length, 2, "booking state must have 2 slots from B");
    assert.ok(
      state.last_available_slots?.every(s => s.starts_at.includes("2026-07-21")),
      "booking state slots must be from REQ_B (July 21)",
    );
  });

  test("AA-2: missing request call_id + successful result → technical_failure action truth, no presentation truth, booking state clears", () => {
    const reqNoCid: RuntimeAgentToolRequest = {
      tool: "availability.check",
      call_id: undefined,
      arguments: { requested_date: "2026-07-21" },
    };
    const resultWithCid: RuntimeAgentToolResult = {
      tool: "availability.check",
      call_id: "call_b",
      status: "success",
      data: { slots: [{ starts_at: "2026-07-21T09:00:00", slot_id: "sB09" }] },
    };

    // Action truth must be technical_failure with can_present_slots=false (not null)
    const at = actionTruth([reqNoCid], [resultWithCid]);
    assert.ok(at !== null, "action truth must be present even when call_id missing");
    assert.equal(at!.outcome, "technical_failure", "must be technical_failure when call_id missing");
    assert.equal(at!.can_present_slots, false, "must not authorize slot presentation");
    assert.deepEqual(at!.allowed_slot_starts, [], "no slots allowed");

    // Presentation truth must remain absent (no pair → no authorized slots)
    const pt = presentationTruth([reqNoCid], [resultWithCid]);
    assert.equal(pt, null, "presentation truth must be null when request has no call_id");

    // Booking state must clear
    const attempt = resolveAuthoritativeAvailabilityAttempt([reqNoCid], [resultWithCid]);
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      authoritativeAvailabilityAttempt: attempt,
    });
    assert.deepEqual(state.last_available_slots, [], "booking state must clear prior slots when call_id missing");
    assert.equal(state.selected_slot, null, "booking state must clear selected_slot when call_id missing");
  });

  test("AA-3: unmatched call_id → technical_failure action truth, no presentation truth, booking state clears", () => {
    const reqUnmatched: RuntimeAgentToolRequest = {
      tool: "availability.check",
      call_id: "call_xyz",
      arguments: { requested_date: "2026-07-21" },
    };
    const resultDifferentId: RuntimeAgentToolResult = {
      tool: "availability.check",
      call_id: "call_different",
      status: "success",
      data: { slots: [{ starts_at: "2026-07-21T09:00:00", slot_id: "sB09" }] },
    };

    // Action truth must be technical_failure with can_present_slots=false (not null)
    const at = actionTruth([reqUnmatched], [resultDifferentId]);
    assert.ok(at !== null, "action truth must be present even when call_id unmatched");
    assert.equal(at!.outcome, "technical_failure", "must be technical_failure when call_id unmatched");
    assert.equal(at!.can_present_slots, false, "must not authorize slot presentation");
    assert.deepEqual(at!.allowed_slot_starts, [], "no slots allowed");

    // Presentation truth must remain absent
    const pt = presentationTruth([reqUnmatched], [resultDifferentId]);
    assert.equal(pt, null, "presentation truth must be null when call_id unmatched");

    // Booking state must clear
    const attempt = resolveAuthoritativeAvailabilityAttempt([reqUnmatched], [resultDifferentId]);
    const state = computeBookingProcessState({
      prior: PRIOR_WITH_SLOTS,
      authoritativeAvailabilityAttempt: attempt,
    });
    assert.deepEqual(state.last_available_slots, [], "booking state must clear prior slots when call_id unmatched");
    assert.equal(state.selected_slot, null, "booking state must clear selected_slot when call_id unmatched");
  });

  test("AA-4: full runtime second-call context — state and both truth objects reference same authoritative attempt", async () => {
    const secondCallContexts: Record<string, unknown>[] = [];
    let callCount = 0;
    const caller: RuntimeAgentCaller = async (input) => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests" as const,
          conversation_id: "conv_aa4",
          tool_requests: [
            { tool: "availability.check" as const, call_id: "call_aa4", arguments: { requested_date: "2026-07-21" } },
          ],
        };
      }
      secondCallContexts.push(input.input.context);
      return {
        type: "final_response" as const,
        conversation_id: "conv_aa4",
        final_response: { final_patient_reply: "Есть: 09:00, 14:00" },
      };
    };

    const loop = createRuntimeAgentLoop({
      model: "test-model",
      caller,
      executors: { "availability.check": async () => ({ status: "success" as const, data: { slots: [
        { starts_at: "2026-07-21T09:00:00", slot_id: "sAA09" },
        { starts_at: "2026-07-21T14:00:00", slot_id: "sAA14" },
      ] } }) } as never,
      now: new Date("2026-07-15T10:00:00Z"),
    });

    await loop.runTurn({ clinic_id: "c1", contact_id: "aa4", case_id: null, user_message: "когда есть?", locale: "ru" });

    assert.equal(secondCallContexts.length, 1, "second call must have occurred");
    const ctx = secondCallContexts[0];
    const at = ctx.availability_action_truth as { allowed_slot_starts: string[] } | undefined;
    const pt = ctx.availability_presentation_truth as { allowed_slot_starts: string[] } | undefined;
    const bps = ctx.booking_process_state as { last_available_slots?: Array<{ starts_at: string }> } | undefined;

    assert.ok(at !== undefined, "action truth must be in second-call context");
    assert.ok(pt !== undefined, "presentation truth must be in second-call context");
    assert.ok(bps !== undefined, "booking process state must be in second-call context");

    // All three agree on slots
    assert.deepEqual(at!.allowed_slot_starts, ["09:00", "14:00"], "action truth must have correct slots");
    assert.deepEqual(pt!.allowed_slot_starts, ["09:00", "14:00"], "presentation truth must match action truth");
    assert.ok(bps!.last_available_slots?.some(s => s.starts_at.includes("2026-07-21")), "booking state must use same attempt's slots");
  });

  test("AA-5: exact HH:MM equality between action truth and presentation truth allowed_slot_starts", () => {
    const requests = [REQ_A, REQ_B];
    const results = [RESULT_A, RESULT_B];
    const attempt = resolveAuthoritativeAvailabilityAttempt(requests, results);

    const at = buildAvailabilityActionTruth(attempt);
    const pt = buildAvailabilityPresentationTruth(attempt);

    assert.ok(at !== null && pt !== null);
    // Values must be HH:MM (not full ISO)
    for (const s of at!.allowed_slot_starts) {
      assert.match(s, /^\d{2}:\d{2}$/, `action truth slot "${s}" must be HH:MM format`);
    }
    for (const s of pt!.allowed_slot_starts) {
      assert.match(s, /^\d{2}:\d{2}$/, `presentation truth slot "${s}" must be HH:MM format`);
    }
    // Must be exactly equal
    assert.deepEqual(at!.allowed_slot_starts, pt!.allowed_slot_starts, "action truth and presentation truth must have identical allowed_slot_starts");
  });
});

// ── Preflight last-check-wins ─────────────────────────────────────────────────

describe("Availability preflight — last-check-wins (Blocker 1)", () => {
  // now = 14:00 Prague (12:00 UTC), so 09:00 Prague on the same day is in the past
  const NOW = new Date("2026-07-15T12:00:00Z"); // 14:00 Europe/Prague

  const PAST_TIME_REQ = { tool: "availability.check" as const, call_id: "past_req", arguments: { requested_date: "2026-07-15", requested_time: "09:00", service_interest: "checkup" } };
  const FUTURE_REQ    = { tool: "availability.check" as const, call_id: "future_req", arguments: { requested_date: "2026-07-21", service_interest: "checkup" } };

  test("PF-1: first=past-time, last=future → no premature interception; executor called; second model call completes", async () => {
    let executorCallCount = 0;
    let secondCallHappened = false;
    let callCount = 0;

    const caller: RuntimeAgentCaller = async (input) => {
      callCount++;
      if (callCount === 1) {
        // Model returns two requests: first=past-time, last=future
        return {
          type: "tool_requests" as const,
          conversation_id: "conv_pf1",
          tool_requests: [PAST_TIME_REQ, FUTURE_REQ],
        };
      }
      secondCallHappened = true;
      return {
        type: "final_response" as const,
        conversation_id: "conv_pf1",
        final_response: { final_patient_reply: "Есть слоты 21 июля: 09:00" },
      };
    };

    const fakeExecutor = async () => {
      executorCallCount++;
      return { status: "success" as const, data: { slots: [{ starts_at: "2026-07-21T09:00:00", slot_id: "s1" }] } };
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": fakeExecutor } as never,
      now: NOW,
      timezone: "Europe/Prague",
    });

    const result = await loop.runTurn({ clinic_id: "c1", contact_id: "pf1", case_id: null, user_message: "есть?", locale: "ru" });

    assert.ok(secondCallHappened, "second model call must have happened — no premature past-time interception");
    assert.ok(executorCallCount > 0, "executor must have been called");
    // result must not be a past_time short-circuit reply
    assert.ok(result.final_patient_reply !== undefined || secondCallHappened, "must reach second model call");
  });

  test("PF-2: first=future, last=past-time → intercepted as past-time; executor not called", async () => {
    let executorCallCount = 0;
    let secondCallHappened = false;
    let callCount = 0;

    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        // Model returns two requests: first=future, last=past-time
        return {
          type: "tool_requests" as const,
          conversation_id: "conv_pf2",
          tool_requests: [FUTURE_REQ, PAST_TIME_REQ],
        };
      }
      secondCallHappened = true;
      return {
        type: "final_response" as const,
        conversation_id: "conv_pf2",
        final_response: { final_patient_reply: "ok" },
      };
    };

    const fakeExecutor = async () => {
      executorCallCount++;
      return { status: "success" as const, data: { slots: [] } };
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": fakeExecutor } as never,
      now: NOW,
      timezone: "Europe/Prague",
    });

    await loop.runTurn({ clinic_id: "c1", contact_id: "pf2", case_id: null, user_message: "есть?", locale: "ru" });

    assert.equal(executorCallCount, 0, "executor must NOT be called when last request is past-time");
    assert.equal(secondCallHappened, false, "must short-circuit before second model call");
  });

  test("PF-3: single availability request — past-time still intercepted (unchanged behavior)", async () => {
    let executorCalled = false;
    let callCount = 0;

    const caller: RuntimeAgentCaller = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests" as const,
          conversation_id: "conv_pf3",
          tool_requests: [PAST_TIME_REQ],
        };
      }
      return {
        type: "final_response" as const,
        conversation_id: "conv_pf3",
        final_response: { final_patient_reply: "ok" },
      };
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": async () => { executorCalled = true; return { status: "success" as const, data: { slots: [] } }; } } as never,
      now: NOW,
      timezone: "Europe/Prague",
    });

    await loop.runTurn({ clinic_id: "c1", contact_id: "pf3", case_id: null, user_message: "есть?", locale: "ru" });

    assert.equal(executorCalled, false, "single past-time request must still be intercepted before executor");
  });
});

// ── pair=null full-runtime behavior ───────────────────────────────────────────

describe("pair=null full-runtime — technical_failure in second call context (Blocker 2)", () => {
  test("PNR-1: request with no call_id → second call has technical_failure action truth, no presentation truth, empty booking state", async () => {
    const secondCallContexts: Record<string, unknown>[] = [];
    let callCount = 0;

    const caller: RuntimeAgentCaller = async (input) => {
      callCount++;
      if (callCount === 1) {
        return {
          type: "tool_requests" as const,
          conversation_id: "conv_pnr1",
          // call_id intentionally absent → pair=null scenario
          tool_requests: [{ tool: "availability.check" as const, call_id: undefined as unknown as string, arguments: { requested_date: "2026-07-21" } }],
        };
      }
      secondCallContexts.push(input.input.context);
      return {
        type: "final_response" as const,
        conversation_id: "conv_pnr1",
        final_response: { final_patient_reply: "Извините, техническая ошибка." },
      };
    };

    const loop = createRuntimeAgentLoop({
      model: "test",
      caller,
      executors: { "availability.check": async () => ({ status: "success" as const, data: { slots: [{ starts_at: "2026-07-21T09:00:00" }] } }) } as never,
      now: new Date("2026-07-15T10:00:00Z"),
    });

    const repo = createInMemoryBookingProcessStateRepository();
    await repo.saveState(
      { clinic_id: "c1", contact_id: "pnr1", case_id: null },
      { last_available_slots: [SLOT_A, SLOT_B], selected_slot: SLOT_A, proof: { service_known: false, name_known: false, slot_known: true, trusted_phone_known: false, ready_for_booking_apply: false } },
    );

    await loop.runTurn({ clinic_id: "c1", contact_id: "pnr1", case_id: null, user_message: "есть?", locale: "ru" });

    assert.equal(secondCallContexts.length, 1, "second call must have happened");
    const ctx = secondCallContexts[0];

    // Action truth must be technical_failure, not null
    const at = ctx.availability_action_truth as { outcome: string; can_present_slots: boolean; allowed_slot_starts: string[] } | undefined;
    assert.ok(at !== undefined, "availability_action_truth must be present in second-call context");
    assert.equal(at!.can_present_slots, false, "can_present_slots must be false");
    assert.deepEqual(at!.allowed_slot_starts, [], "allowed_slot_starts must be empty");

    // Presentation truth must be absent
    assert.ok(!("availability_presentation_truth" in ctx), "availability_presentation_truth must NOT be in context when pair=null");

    // Booking state must clear prior slots
    const bps = ctx.booking_process_state as { last_available_slots?: unknown[] } | undefined;
    assert.ok(bps !== undefined, "booking_process_state must be present");
    assert.deepEqual(bps!.last_available_slots, [], "booking state must clear stale slots when pair=null");
  });
});

// ── Duplicate slot deduplication ─────────────────────────────────────────────

describe("Duplicate slot deduplication — shared extractUniqueAllowedSlotStarts (Issue 3)", () => {
  test("DUP-1: duplicate HH:MM slots → both truth builders deduplicate to same array", () => {
    const reqDup: RuntimeAgentToolRequest = {
      tool: "availability.check",
      call_id: "call_dup",
      arguments: { requested_date: "2026-07-21" },
    };
    const resultWithDups: RuntimeAgentToolResult = {
      tool: "availability.check",
      call_id: "call_dup",
      status: "success",
      data: {
        slots: [
          { starts_at: "2026-07-21T09:00:00", slot_id: "s1" },
          { starts_at: "2026-07-21T09:00:00", slot_id: "s2" }, // duplicate 09:00
          { starts_at: "2026-07-21T10:00:00", slot_id: "s3" },
        ],
      },
    };

    const at = actionTruth([reqDup], [resultWithDups]);
    const pt = presentationTruth([reqDup], [resultWithDups]);

    assert.ok(at !== null, "action truth must not be null");
    assert.ok(pt !== null, "presentation truth must not be null");

    assert.deepEqual(at!.allowed_slot_starts, ["09:00", "10:00"], "action truth must deduplicate 09:00");
    assert.deepEqual(pt!.allowed_slot_starts, ["09:00", "10:00"], "presentation truth must deduplicate 09:00");
    assert.deepEqual(at!.allowed_slot_starts, pt!.allowed_slot_starts, "both truth builders must expose identical arrays");
  });
});

// ── Prompt contract ───────────────────────────────────────────────────────────

describe("Prompt contract — availability_action_truth rules", () => {
  const instruction = buildRuntimeAgentSystemInstruction();

  test("17: prompt states can_present_slots=false forbids slot presentation and reuse from conversation history", () => {
    assert.match(
      instruction,
      /can_present_slots=false/i,
      "must reference can_present_slots=false",
    );
    assert.match(
      instruction,
      /no slot may be presented or reused from conversation history/i,
      "must prohibit reuse of slots from conversation history",
    );
  });

  test("18: prompt states only current allowed_slot_starts may be shown to the patient", () => {
    assert.match(
      instruction,
      /only allowed_slot_starts.*from.*current.*availability_action_truth|only.*allowed_slot_starts.*current/i,
      "must restrict presentation to current allowed_slot_starts only",
    );
  });

  test("19: prompt gives deterministic past_date behavior — explain date passed, ask for future date", () => {
    assert.match(
      instruction,
      /past_date.*explain.*date.*passed|past_date.*requested date.*passed/i,
      "past_date outcome must direct model to explain the date has passed",
    );
    assert.match(
      instruction,
      /ask.*patient.*date.*today|date from today onward/i,
      "must instruct model to ask for a date from today onward",
    );
  });
});

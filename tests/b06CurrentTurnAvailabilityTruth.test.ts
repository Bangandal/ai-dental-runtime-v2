import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeTurnModelProjection,
  enforceCurrentTurnAvailabilityPresentationBoundary,
} from "../src/runtime/runtimeTurnModelContext.ts";
import type {
  BookingProcessState,
  ModelVisibleBookingProcessState,
} from "../src/runtime/bookingProcessState.ts";

const NOW = new Date("2099-08-21T12:00:00.000Z");
const CHECKED_AT = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
const TIMEZONE = "Europe/Prague";

function withRuntimeAgentMode<T>(mode: "legacy" | "agent_first", fn: () => T): T {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
}

function persistedOfferState(opts: { selected?: boolean } = {}): BookingProcessState {
  const selected = opts.selected ?? false;
  return {
    service_reason: "cleaning",
    first_name: "Mikhail",
    last_available_slots: [
      { starts_at: "2099-08-22T10:00:00" },
      { starts_at: "2099-08-22T12:00:00" },
    ],
    selected_slot: selected ? { starts_at: "2099-08-22T12:00:00" } : null,
    active_availability_evidence: {
      availability_call_id: "prior_availability",
      requested_date: "2099-08-22",
      requested_time: null,
      allowed_slot_keys: ["2099-08-22T10:00", "2099-08-22T12:00"],
      checked_at: CHECKED_AT,
    },
    phone_trusted: true,
    next_action: selected ? "ready_for_booking_apply" : "choose_from_available_slots",
    proof: {
      service_known: true,
      name_known: true,
      slot_known: selected,
      trusted_phone_known: true,
      ready_for_booking_apply: selected,
    },
  };
}

test("B-06: agent-first initial model call cannot present slots from prior-turn evidence", () => {
  withRuntimeAgentMode("agent_first", () => {
    const prior = persistedOfferState();
    const projection = buildRuntimeTurnModelProjection({
      caller_context: { locale: "ru" },
      prior_booking_process_state: prior,
      booking_process_state: prior,
      processed_tool_requests: [],
      tool_results: [],
      now: NOW,
      timezone: TIMEZONE,
    });

    assert.deepEqual(projection.visible_booking_process_state.last_available_slots, []);
    assert.equal(projection.visible_booking_process_state.next_action, undefined);
    assert.equal(projection.availability_presentation_truth, null);
    assert.equal("availability_presentation_truth" in projection.context, false);
  });
});

test("B-06: a current-turn successful availability.check restores presentation authority", () => {
  withRuntimeAgentMode("agent_first", () => {
    const availabilityRequest = {
      tool: "availability.check" as const,
      call_id: "current_availability",
      arguments: { requested_date: "2099-08-22" },
    };
    const availabilityResult = {
      tool: "availability.check" as const,
      call_id: "current_availability",
      status: "success" as const,
      data: {
        slots: [
          { starts_at: "2099-08-22T10:00:00" },
          { starts_at: "2099-08-22T12:00:00" },
        ],
        total_slots: 2,
        free_slots_count: 2,
      },
    };
    const current = persistedOfferState();

    const projection = buildRuntimeTurnModelProjection({
      caller_context: { locale: "ru" },
      prior_booking_process_state: null,
      booking_process_state: current,
      processed_tool_requests: [availabilityRequest],
      tool_results: [availabilityResult],
      now: NOW,
      timezone: TIMEZONE,
    });

    assert.deepEqual(
      projection.visible_booking_process_state.last_available_slots?.map((slot) => slot.starts_at),
      ["2099-08-22T10:00:00", "2099-08-22T12:00:00"],
    );
    assert.deepEqual(
      projection.availability_presentation_truth?.allowed_slot_starts,
      ["10:00", "12:00"],
    );
  });
});

test("B-06: presentation boundary does not erase a previously selected slot or booking proof", () => {
  const state: ModelVisibleBookingProcessState = {
    ...persistedOfferState({ selected: true }),
    active_availability_evidence: undefined,
    next_action_confidence: "high",
    slot_evidence_status: "verified",
  };

  const projected = enforceCurrentTurnAvailabilityPresentationBoundary({
    state,
    current_turn_truth: null,
    require_current_turn_truth: true,
  });

  assert.deepEqual(projected.last_available_slots, []);
  assert.equal(projected.selected_slot?.starts_at, "2099-08-22T12:00:00");
  assert.equal(projected.proof?.slot_known, true);
  assert.equal(projected.proof?.ready_for_booking_apply, true);
  assert.equal(projected.next_action, "ready_for_booking_apply");
});

test("B-06: legacy remains unchanged as the control path", () => {
  withRuntimeAgentMode("legacy", () => {
    const prior = persistedOfferState();
    const projection = buildRuntimeTurnModelProjection({
      caller_context: { locale: "ru" },
      prior_booking_process_state: prior,
      booking_process_state: prior,
      processed_tool_requests: [],
      tool_results: [],
      now: NOW,
      timezone: TIMEZONE,
    });

    assert.deepEqual(
      projection.visible_booking_process_state.last_available_slots?.map((slot) => slot.starts_at),
      ["2099-08-22T10:00:00", "2099-08-22T12:00:00"],
    );
    assert.equal(projection.visible_booking_process_state.next_action, "choose_from_available_slots");
  });
});

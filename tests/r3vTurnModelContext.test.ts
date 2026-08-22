import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeTurnModelProjection } from "../src/runtime/runtimeTurnModelContext.ts";
import { computeBookingProcessState } from "../src/runtime/bookingProcessState.ts";

const NOW = new Date("2099-08-21T12:00:00Z");

test("R3v: model projection is determined by accumulated state/results, not model-call number", () => {
  const bookingState = computeBookingProcessState({
    prior: null,
    channelContact: null,
    now: NOW,
  });

  const params = {
    caller_context: { locale: "ru", stable: true },
    prior_booking_process_state: null,
    booking_process_state: bookingState,
    processed_tool_requests: [
      { tool: "kb.search" as const, call_id: "kb_1", arguments: { query: "price" } },
    ],
    tool_results: [
      {
        tool: "kb.search" as const,
        call_id: "kb_1",
        status: "success" as const,
        data: { chunks: [{ chunk_id: "faq", text: "price" }] },
      },
    ],
    now: NOW,
    timezone: "Europe/Prague",
  };

  const a = buildRuntimeTurnModelProjection(params);
  const b = buildRuntimeTurnModelProjection(params);

  assert.deepEqual(a, b);
  assert.equal(a.context.stable, true);
  assert.ok("booking_process_state" in a.context);
  assert.equal("booking_apply_action_truth" in a.context, false);
  assert.equal("availability_action_truth" in a.context, false);
});

test("R3v: accumulated availability evidence is projected through the same owner", () => {
  const availabilityResult = {
    tool: "availability.check" as const,
    call_id: "avail_1",
    status: "success" as const,
    data: { slots: [{ starts_at: "2099-08-22T10:00:00" }], total_slots: 1, free_slots_count: 1 },
  };
  const availabilityRequest = {
    tool: "availability.check" as const,
    call_id: "avail_1",
    arguments: { requested_date: "2099-08-22" },
  };

  const bookingState = computeBookingProcessState({
    prior: null,
    channelContact: null,
    toolResults: [availabilityResult],
    now: NOW,
  });

  const projection = buildRuntimeTurnModelProjection({
    caller_context: { locale: "ru" },
    prior_booking_process_state: null,
    booking_process_state: bookingState,
    processed_tool_requests: [availabilityRequest],
    tool_results: [availabilityResult],
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.ok(projection.availability_action_truth);
  assert.ok(projection.availability_presentation_truth);
  assert.ok("availability_action_truth" in projection.context);
  assert.ok("availability_presentation_truth" in projection.context);
});

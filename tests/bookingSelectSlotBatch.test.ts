import assert from "node:assert/strict";
import test from "node:test";

import { executeBookingSelectSlotBatch } from "../src/runtime/bookingSelectSlot.ts";
import type { AvailabilityEvidence } from "../src/runtime/slotEvidence.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

const evidence: AvailabilityEvidence = {
  availability_call_id: "av_pf004b",
  requested_date: "2028-01-15",
  requested_time: null,
  allowed_slot_keys: ["2028-01-15T10:00", "2028-01-15T14:00"],
};

function select(callId: string, time: string): RuntimeAgentToolRequest {
  return {
    tool: "booking.select_slot",
    call_id: callId,
    arguments: {
      subject_id: "subject_1",
      requested_date: "2028-01-15",
      requested_time: time,
    },
  };
}

test("PF-004b-UNIT-1: one valid selection succeeds without any model-round input", () => {
  const result = executeBookingSelectSlotBatch({
    requests: [select("ss_1", "10:00")],
    activeEvidence: evidence,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.success_data?.selected_slot_key, "2028-01-15T10:00");
  assert.equal(result.tool_results.length, 1);
  assert.equal(result.tool_results[0]?.status, "success");
});

test("PF-004b-UNIT-2: multiple selections fail closed as ambiguous and create no proof data", () => {
  const result = executeBookingSelectSlotBatch({
    requests: [select("ss_a", "10:00"), select("ss_b", "14:00")],
    activeEvidence: evidence,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.success_data, null);
  assert.equal(result.tool_results.length, 2);
  for (const toolResult of result.tool_results) {
    assert.equal(toolResult.status, "failed");
    assert.equal(toolResult.error?.code, "ambiguous_selection");
  }
});

test("PF-004b-UNIT-3: failed selection still counts as an attempt so caller revokes old proof", () => {
  const result = executeBookingSelectSlotBatch({
    requests: [select("ss_bad", "11:00")],
    activeEvidence: evidence,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.success_data, null);
  assert.equal(result.tool_results[0]?.status, "failed");
  assert.equal(result.tool_results[0]?.error?.code, "slot_not_in_active_evidence");
});

test("PF-004b-UNIT-4: no select_slot request is a no-op", () => {
  const result = executeBookingSelectSlotBatch({
    requests: [{ tool: "kb.search", call_id: "kb_1", arguments: { query: "x" } }],
    activeEvidence: evidence,
  });

  assert.equal(result.attempted, false);
  assert.equal(result.success_data, null);
  assert.deepEqual(result.tool_results, []);
});

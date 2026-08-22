import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBookingSelectApplyBatchConflict } from "../src/runtime/bookingSelectApplyBatchConflict.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

const EVIDENCE = {
  availability_call_id: "av_1",
  requested_date: "2028-03-10",
  requested_time: null,
  allowed_slot_keys: ["2028-03-10T10:00", "2028-03-10T14:00"],
};

function select(callId = "ss_1", time = "10:00"): RuntimeAgentToolRequest {
  return {
    tool: "booking.select_slot",
    call_id: callId,
    arguments: { subject_id: "subject_1", requested_date: "2028-03-10", requested_time: time },
  };
}

function apply(callId = "ba_1", time = "10:00"): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: callId,
    arguments: {
      subject_id: "subject_1",
      first_name: "Anna",
      last_name: "Ivanova",
      service: "cleaning",
      requested_date: "2028-03-10",
      requested_time: time,
    },
  };
}

test("R3p: no conflict without both select_slot and exactly one booking.apply", () => {
  assert.equal(resolveBookingSelectApplyBatchConflict({
    requests: [select()], activeEvidence: EVIDENCE,
  }), null);
  assert.equal(resolveBookingSelectApplyBatchConflict({
    requests: [apply()], activeEvidence: EVIDENCE,
  }), null);
  assert.equal(resolveBookingSelectApplyBatchConflict({
    requests: [select(), apply("ba_1"), apply("ba_2")], activeEvidence: EVIDENCE,
  }), null, "stronger multiple-booking guard owns batches with more than one apply");
});

test("R3p: successful selection is recorded but same-batch booking.apply is blocked", () => {
  const result = resolveBookingSelectApplyBatchConflict({
    requests: [select(), apply()],
    activeEvidence: EVIDENCE,
  });

  assert.ok(result);
  assert.equal(result.selection.attempted, true);
  assert.equal(result.selection.success_data?.selected_slot_key, "2028-03-10T10:00");
  assert.deepEqual(result.tool_results.map((r) => r.call_id), ["ss_1", "ba_1"]);
  assert.equal(result.tool_results[0]?.status, "success");
  const bookingData = result.tool_results[1]?.data as Record<string, unknown>;
  assert.equal(bookingData.booking_status, "slot_not_verified");
  assert.equal(bookingData.created_visit, false);
  assert.equal(bookingData.may_claim_booked, false);
  assert.equal(bookingData.required_next_action, "retry_booking_apply");
  assert.equal(bookingData.reason, "select_slot_and_booking_apply_same_round");
});

test("R3p: failed or ambiguous selection still blocks apply and revokes proof at caller", () => {
  const failed = resolveBookingSelectApplyBatchConflict({
    requests: [select("ss_bad", "11:00"), apply("ba_bad", "11:00")],
    activeEvidence: EVIDENCE,
  });
  assert.ok(failed);
  assert.equal(failed.selection.attempted, true);
  assert.equal(failed.selection.success_data, null);
  assert.equal(failed.tool_results[0]?.status, "failed");
  assert.equal(failed.tool_results[0]?.error?.code, "slot_not_in_active_evidence");
  assert.equal((failed.tool_results[1]?.data as Record<string, unknown>).booking_status, "slot_not_verified");

  const ambiguous = resolveBookingSelectApplyBatchConflict({
    requests: [select("ss_a", "10:00"), select("ss_b", "14:00"), apply()],
    activeEvidence: EVIDENCE,
  });
  assert.ok(ambiguous);
  assert.equal(ambiguous.selection.attempted, true);
  assert.equal(ambiguous.selection.success_data, null);
  assert.deepEqual(ambiguous.tool_results.slice(0, 2).map((r) => r.error?.code), ["ambiguous_selection", "ambiguous_selection"]);
  assert.equal((ambiguous.tool_results[2]?.data as Record<string, unknown>).booking_status, "slot_not_verified");
});

test("R3p: conflict result set closes every call id in the model batch", () => {
  const other: RuntimeAgentToolRequest = {
    tool: "kb.search",
    call_id: "kb_1",
    arguments: { query: "price" },
  };
  const result = resolveBookingSelectApplyBatchConflict({
    requests: [other, select(), apply()],
    activeEvidence: EVIDENCE,
  });
  assert.ok(result);
  assert.deepEqual(new Set(result.tool_results.map((r) => r.call_id)), new Set(["kb_1", "ss_1", "ba_1"]));
  const denied = result.tool_results.find((r) => r.call_id === "kb_1");
  assert.equal(denied?.status, "denied");
  assert.equal(denied?.error?.code, "guard_s_same_round_protocol");
});

test("R3p structure: legacy loop delegates same-batch select/apply conflict in both tool phases", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.equal(
    loopSource.match(/resolveBookingSelectApplyBatchConflict\(\{/g)?.length,
    2,
    "both current tool-batch paths must use the same content-based protocol guard",
  );
  assert.doesNotMatch(loopSource, /guard_s_same_round_protocol/);
  assert.doesNotMatch(loopSource, /Tool was not executed because booking\.select_slot and booking\.apply/);
});

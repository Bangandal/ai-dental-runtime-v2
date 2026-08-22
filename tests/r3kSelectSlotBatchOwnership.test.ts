import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeBookingSelectSlotBatch } from "../src/runtime/bookingSelectSlot.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";
import type { AvailabilityEvidence } from "../src/runtime/slotEvidence.ts";

const EVIDENCE: AvailabilityEvidence = {
  availability_call_id: "avail_1",
  requested_date: "2099-08-22",
  requested_time: null,
  allowed_slot_keys: ["2099-08-22T14:00"],
  checked_at: "2099-08-22T08:00:00Z",
};

function select(callId: string, time = "14:00"): RuntimeAgentToolRequest {
  return {
    tool: "booking.select_slot",
    call_id: callId,
    arguments: {
      subject_id: "subject_1",
      requested_date: "2099-08-22",
      requested_time: time,
    },
  };
}

test("R3k: select-slot batch preserves request ordering for ambiguous selections", () => {
  const result = executeBookingSelectSlotBatch({
    requests: [select("select_a"), select("select_b")],
    activeEvidence: EVIDENCE,
    subjects: null,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.success_data, null);
  assert.deepEqual(result.tool_results.map((item) => item.call_id), ["select_a", "select_b"]);
  assert.ok(result.tool_results.every((item) => item.status === "failed"));
  assert.ok(result.tool_results.every((item) => item.error?.code === "ambiguous_selection"));
});

test("R3k: single select-slot batch preserves the deterministic success payload", () => {
  const result = executeBookingSelectSlotBatch({
    requests: [select("select_a")],
    activeEvidence: EVIDENCE,
    subjects: null,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.success_data?.selected_slot_key, "2099-08-22T14:00");
  assert.equal(result.tool_results[0]?.call_id, "select_a");
  assert.equal(result.tool_results[0]?.status, "success");
});

test("R3k structure: legacy loop delegates every current select-slot path to the batch helper", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.match(loopSource, /import \{ executeBookingSelectSlotBatch \} from ["']\.\/bookingSelectSlot\.ts["']/);
  assert.equal(
    loopSource.match(/executeBookingSelectSlotBatch\(\{/g)?.length,
    3,
    "Guard S, first normal tool batch, and later tool batch must share one selector",
  );
  assert.doesNotMatch(loopSource, /executeBookingSelectSlot\(/);
  assert.doesNotMatch(loopSource, /BookingSelectSlotSuccessData/);
  assert.doesNotMatch(loopSource, /selectSlotAmbiguous/);
  assert.doesNotMatch(loopSource, /selectSlotRequestCount/);
});

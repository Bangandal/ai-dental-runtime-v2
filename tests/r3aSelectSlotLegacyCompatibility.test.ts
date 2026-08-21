import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIRuntimeAgentCaller } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { executeBookingSelectSlot } from "../src/runtime/bookingSelectSlot.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

function callerInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_legacy_r3a",
    system_instruction: "system",
    input: {
      message: "14:00 подходит",
      context: { runtime_context: null },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  };
}

test("R3a legacy compatibility: hidden subject_2 without registry stays fail-closed instead of being remapped to self", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          tool_calls: [{
            name: "booking_select_slot",
            call_id: "legacy_select",
            arguments: JSON.stringify({
              subject_id: "subject_2",
              requested_date: "2099-08-21",
              requested_time: "14:00",
            }),
          }],
        }),
      },
    },
  });

  const normalized = await caller(callerInput() as never);
  assert.equal(normalized.type, "tool_requests");
  if (normalized.type !== "tool_requests") return;
  const request = normalized.tool_requests[0]!;
  assert.equal(request.arguments.subject_id, "subject_2");

  const result = executeBookingSelectSlot(
    request.arguments,
    {
      availability_call_id: "avail_1",
      requested_date: "2099-08-21",
      requested_time: "14:00",
      allowed_slot_keys: ["2099-08-21T14:00"],
      checked_at: "2099-08-21T08:00:00.000Z",
    },
    null,
  );
  assert.deepEqual(result, { ok: false, reason: "subject_resolution_conflict" });
});

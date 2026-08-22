import assert from "node:assert/strict";
import test from "node:test";

import { executeRuntimeNonWriteToolBatch } from "../src/runtime/runtimeNonWriteToolBatch.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

const INPUT = {
  clinic_id: "clinic_r3q",
  contact_id: "contact_r3q",
  case_id: null,
  user_message: "Проверьте информацию",
  locale: "ru",
  trace_id: "trace_r3q",
};

test("R3q: non-write batch executes active read tools, skips slot/write owners, and closes inactive calls", async () => {
  const executed: string[] = [];
  const requests: RuntimeAgentToolRequest[] = [
    { tool: "kb.search", call_id: "kb_1", arguments: { query: "цена чистки" } },
    { tool: "booking.select_slot", call_id: "slot_1", arguments: { subject_id: "subject_1", requested_date: "2099-08-22", requested_time: "10:00" } },
    { tool: "availability.check", call_id: "avail_1", arguments: { requested_date: "2099-08-22" } },
    { tool: "booking.apply", call_id: "book_1", arguments: { subject_id: "subject_1" } },
    { tool: "hold.create", call_id: "future_1", arguments: {} },
  ];

  const result = await executeRuntimeNonWriteToolBatch({
    requests,
    input: INPUT,
    now: new Date("2099-08-21T12:00:00Z"),
    executors: {
      "kb.search": async () => {
        executed.push("kb.search");
        return {
          tool: "kb.search" as const,
          status: "success" as const,
          data: { query: "цена чистки", chunks: [] },
        };
      },
      "availability.check": async () => {
        executed.push("availability.check");
        return {
          tool: "availability.check" as const,
          status: "success" as const,
          data: {
            slots: [{
              slot_id: "slot_2099",
              starts_at: "2099-08-22T10:00:00",
              ends_at: "2099-08-22T10:30:00",
            }],
          },
          _diagnostic: { source: "test" },
        };
      },
    },
  });

  assert.deepEqual(executed, ["kb.search", "availability.check"]);
  assert.deepEqual(result.tool_results.map((item) => item.call_id), ["kb_1", "avail_1", "future_1"]);
  assert.equal(result.tool_results[0]?.status, "success");
  assert.equal(result.tool_results[1]?.status, "success");
  assert.equal(result.tool_results[2]?.status, "denied");
  assert.equal(result.tool_results[2]?.error?.code, "tool_not_active");
  assert.deepEqual(result.availability_diagnostic, { source: "test" });
  assert.equal(result.tool_results.some((item) => item.call_id === "slot_1"), false);
  assert.equal(result.tool_results.some((item) => item.call_id === "book_1"), false);
});

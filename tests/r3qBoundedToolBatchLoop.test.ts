import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";

const NOW = new Date("2099-08-21T12:00:00Z");

function kbSuccess() {
  return {
    tool: "kb.search" as const,
    status: "success" as const,
    data: { query: "faq", chunks: [] },
  };
}

test("R3q: second non-write tool batch is executed and resolved in the same conversation before third final response", async () => {
  let callerCount = 0;
  let kbCalls = 0;
  let availabilityCalls = 0;

  const caller: RuntimeAgentCaller = async (input) => {
    callerCount++;

    if (callerCount === 1) {
      assert.equal(input.conversation_id, "conv_r3q_1");
      assert.equal(input.input.tool_results, undefined);
      assert.ok(input.input.tool_definitions);
      return {
        type: "tool_requests",
        conversation_id: "conv_r3q_1",
        tool_requests: [
          { tool: "kb.search", call_id: "kb_first", arguments: { query: "faq" } },
        ],
      };
    }

    if (callerCount === 2) {
      assert.equal(input.conversation_id, "conv_r3q_1");
      assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["kb_first"]);
      assert.ok(input.input.tool_definitions);
      return {
        type: "tool_requests",
        conversation_id: "conv_r3q_1",
        tool_requests: [
          { tool: "availability.check", call_id: "avail_second", arguments: { requested_date: "2099-08-22" } },
        ],
      };
    }

    assert.equal(callerCount, 3, "bounded path must make exactly three model calls");
    assert.equal(input.conversation_id, "conv_r3q_1", "third call must continue the same resolved conversation");
    assert.deepEqual(
      input.input.tool_results?.map((item) => item.call_id),
      ["avail_second"],
      "third call must submit only outputs for the pending second batch",
    );
    assert.equal(input.input.tool_definitions, undefined, "third call is the bounded finalization step");
    return {
      type: "final_response",
      conversation_id: "conv_r3q_1",
      final_response: { final_patient_reply: "На завтра есть время." },
    };
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    now: NOW,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return kbSuccess();
      },
      "availability.check": async () => {
        availabilityCalls++;
        return {
          tool: "availability.check" as const,
          status: "success" as const,
          data: {
            slots: [{
              slot_id: "slot_r3q",
              starts_at: "2099-08-22T10:00:00",
              ends_at: "2099-08-22T10:30:00",
            }],
            total_slots: 1,
            free_slots_count: 1,
          },
        };
      },
    },
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_r3q",
    contact_id: "contact_r3q",
    case_id: null,
    conversation_id: "conv_r3q_1",
    user_message: "Проверьте и скажите время",
    locale: "ru",
    trace_id: "trace_r3q_1",
  });

  assert.equal(callerCount, 3);
  assert.equal(kbCalls, 1);
  assert.equal(availabilityCalls, 1, "second-batch availability.check must actually execute");
  assert.deepEqual(result.tool_requests.map((item) => item.call_id), ["kb_first", "avail_second"]);
  assert.deepEqual(result.tool_results.map((item) => item.call_id), ["kb_first", "avail_second"]);
  assert.equal(result.final_patient_reply, "На завтра есть время.");
  assert.equal(result.conversation_id, "conv_r3q_1");
  assert.notEqual(result.conversation_id_resumable, false, "all pending call ids were resolved, so conversation stays resumable");
  assert.equal((result.debug as Record<string, unknown>)?.reason, "bounded_tool_batch_final_response");
});

test("R3q: third model step requesting more tools exhausts the budget and dirties the conversation", async () => {
  let callerCount = 0;
  let kbCalls = 0;

  const caller: RuntimeAgentCaller = async (input) => {
    callerCount++;
    if (callerCount === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_r3q_budget",
        tool_requests: [{ tool: "kb.search", call_id: "kb_1", arguments: { query: "one" } }],
      };
    }
    if (callerCount === 2) {
      return {
        type: "tool_requests",
        conversation_id: "conv_r3q_budget",
        tool_requests: [{ tool: "kb.search", call_id: "kb_2", arguments: { query: "two" } }],
      };
    }

    assert.equal(input.input.tool_definitions, undefined);
    assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["kb_2"]);
    return {
      type: "tool_requests",
      conversation_id: "conv_r3q_budget",
      tool_requests: [{ tool: "kb.search", call_id: "kb_3_unresolved", arguments: { query: "three" } }],
    };
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    now: NOW,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return kbSuccess();
      },
    },
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_r3q",
    contact_id: "contact_budget",
    case_id: null,
    conversation_id: "conv_r3q_budget",
    user_message: "Сделай несколько проверок",
    locale: "ru",
    trace_id: "trace_r3q_budget",
  });

  assert.equal(callerCount, 3, "budget exhaustion must not create a hidden fourth model call");
  assert.equal(kbCalls, 2, "third-step tool request must not be executed after budget exhaustion");
  assert.equal(result.conversation_id, null);
  assert.equal(result.conversation_id_resumable, false);
  assert.equal((result.debug as Record<string, unknown>)?.reason, "bounded_tool_batch_budget_exhausted");
  assert.ok(result.tool_requests.some((item) => item.call_id === "kb_3_unresolved"), "unresolved final request remains observable");
  assert.equal(result.tool_results.some((item) => item.call_id === "kb_3_unresolved"), false);
});

test("R3q structure: second non-write batch has one executor and one bounded continuation path", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.match(loopSource, /import \{ executeRuntimeNonWriteToolBatch \} from ["']\.\/runtimeNonWriteToolBatch\.ts["']/);
  assert.equal(
    loopSource.match(/executeRuntimeNonWriteToolBatch\(\{/g)?.length,
    1,
    "later non-write batches must have one execution owner",
  );
  assert.equal(
    loopSource.match(/debug\.reason = "bounded_tool_batch_final_response"/g)?.length,
    1,
    "bounded continuation must have one successful terminal marker",
  );
  assert.match(loopSource, /tool_results: round2ToolResults/);
  assert.match(loopSource, /conversation_id: conversationId/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeTurnModelToolOrchestration } from "../src/runtime/runtimeTurnModelToolOrchestrator.ts";
import { createRuntimeModelIterationState } from "../src/runtime/runtimeModelIteration.ts";
import { computeBookingProcessState } from "../src/runtime/bookingProcessState.ts";
import type { RuntimeAgentCaller } from "../src/runtime/runtimeModelCall.ts";

const NOW = new Date("2099-08-21T12:00:00Z");

function baseInput() {
  return {
    clinic_id: "clinic_r3v",
    contact_id: "contact_r3v",
    case_id: null,
    conversation_id: "conv_r3v",
    user_message: "test",
    locale: "ru",
    trace_id: "trace_r3v",
  };
}

test("R3v: two executable tool batches use one orchestration path and terminal third model call", async () => {
  let modelCalls = 0;
  let kbCalls = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    modelCalls++;
    if (modelCalls === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_r3v",
        tool_requests: [{ tool: "kb.search", call_id: "kb_1", arguments: { query: "one" } }],
      };
    }
    if (modelCalls === 2) {
      assert.ok(input.input.tool_definitions);
      assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["kb_1"]);
      return {
        type: "tool_requests",
        conversation_id: "conv_r3v",
        tool_requests: [{ tool: "kb.search", call_id: "kb_2", arguments: { query: "two" } }],
      };
    }
    assert.equal(input.input.tool_definitions, undefined);
    assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["kb_2"]);
    return {
      type: "final_response",
      conversation_id: "conv_r3v",
      final_response: { final_patient_reply: "done" },
    };
  };

  const outcome = await runRuntimeTurnModelToolOrchestration({
    model_state: createRuntimeModelIterationState("conv_r3v"),
    caller,
    model: "test-model",
    system_instruction: "system",
    input: baseInput(),
    caller_context: { locale: "ru" },
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return {
          tool: "kb.search" as const,
          status: "success" as const,
          data: { chunks: [{ chunk_id: `kb_${kbCalls}`, text: "ok" }] },
        };
      },
    },
    prior_booking_process_state: null,
    initial_booking_process_state: computeBookingProcessState({ prior: null, now: NOW }),
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(outcome.kind, "final_response");
  assert.equal(modelCalls, 3);
  assert.equal(kbCalls, 2);
  assert.deepEqual(outcome.domain_state.processed_tool_requests.map((item) => item.call_id), ["kb_1", "kb_2"]);
  assert.deepEqual(outcome.domain_state.tool_results.map((item) => item.call_id), ["kb_1", "kb_2"]);
});

test("R3v: multiple booking.apply in any executable batch is closed by the shared batch owner and next call is terminal", async () => {
  let modelCalls = 0;
  let bookingCalls = 0;
  let kbCalls = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    modelCalls++;
    if (modelCalls === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_multi",
        tool_requests: [
          { tool: "booking.apply", call_id: "book_a", arguments: {} },
          { tool: "booking.apply", call_id: "book_b", arguments: {} },
          { tool: "kb.search", call_id: "kb_sibling", arguments: { query: "x" } },
        ],
      };
    }
    assert.equal(input.input.tool_definitions, undefined, "multiple-write guard must force response-only continuation");
    assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["book_a", "book_b", "kb_sibling"]);
    return {
      type: "final_response",
      conversation_id: "conv_multi",
      final_response: { final_patient_reply: "clarify" },
    };
  };

  const outcome = await runRuntimeTurnModelToolOrchestration({
    model_state: createRuntimeModelIterationState("conv_multi"),
    caller,
    model: "test-model",
    system_instruction: "system",
    input: baseInput(),
    caller_context: {},
    executors: {
      "booking.apply": async () => {
        bookingCalls++;
        return { tool: "booking.apply" as const, status: "success" as const, data: {} };
      },
      "kb.search": async () => {
        kbCalls++;
        return { tool: "kb.search" as const, status: "success" as const, data: { chunks: [] } };
      },
    },
    prior_booking_process_state: null,
    initial_booking_process_state: computeBookingProcessState({ prior: null, now: NOW }),
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(outcome.kind, "final_response");
  assert.equal(modelCalls, 2);
  assert.equal(bookingCalls, 0);
  assert.equal(kbCalls, 0);
  assert.equal(outcome.domain_state.last_guarded_booking_apply_data?.reason, "multiple_booking_apply_requests");
  assert.deepEqual(outcome.domain_state.tool_results.map((item) => item.call_id), ["book_a", "book_b", "kb_sibling"]);
});

test("R3v: explicit past-time availability is blocked before executor on a later batch too", async () => {
  let modelCalls = 0;
  let kbCalls = 0;
  let availabilityCalls = 0;
  const caller: RuntimeAgentCaller = async () => {
    modelCalls++;
    if (modelCalls === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_past",
        tool_requests: [{ tool: "kb.search", call_id: "kb_first", arguments: { query: "x" } }],
      };
    }
    return {
      type: "tool_requests",
      conversation_id: "conv_past",
      tool_requests: [{
        tool: "availability.check",
        call_id: "avail_past",
        arguments: { requested_date: "2099-08-21", requested_time: "10:00" },
      }],
    };
  };

  const outcome = await runRuntimeTurnModelToolOrchestration({
    model_state: createRuntimeModelIterationState("conv_past"),
    caller,
    model: "test-model",
    system_instruction: "system",
    input: baseInput(),
    caller_context: {},
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return { tool: "kb.search" as const, status: "success" as const, data: { chunks: [{ chunk_id: "1", text: "ok" }] } };
      },
      "availability.check": async () => {
        availabilityCalls++;
        return { tool: "availability.check" as const, status: "success" as const, data: { slots: [] } };
      },
    },
    prior_booking_process_state: null,
    initial_booking_process_state: computeBookingProcessState({ prior: null, now: NOW }),
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(outcome.kind, "batch_aborted");
  if (outcome.kind !== "batch_aborted") return;
  assert.equal(outcome.reason, "availability_preflight_past_time");
  assert.equal(modelCalls, 2);
  assert.equal(kbCalls, 1);
  assert.equal(availabilityCalls, 0);
  assert.deepEqual(outcome.domain_state.processed_tool_requests.map((item) => item.call_id), ["kb_first", "avail_past"]);
  assert.equal(outcome.domain_state.past_time_detail?.requestedTime, "10:00");
});

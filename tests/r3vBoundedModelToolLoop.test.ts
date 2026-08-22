import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeBoundedModelToolLoop } from "../src/runtime/runtimeBoundedModelToolLoop.ts";
import { createRuntimeModelIterationState } from "../src/runtime/runtimeModelIteration.ts";
import type { RuntimeAgentCaller } from "../src/runtime/runtimeModelCall.ts";

function toolRequest(callId: string) {
  return {
    tool: "kb.search" as const,
    call_id: callId,
    arguments: { query: callId },
  };
}

test("R3v: iterator runs model -> batch -> model without round-specific transport branches", async () => {
  let calls = 0;
  let batches = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    calls++;
    if (calls === 1) {
      assert.ok(input.input.tool_definitions);
      assert.equal(input.input.tool_results, undefined);
      return {
        type: "tool_requests",
        conversation_id: "conv_r3v",
        tool_requests: [toolRequest("kb_1")],
      };
    }
    assert.ok(input.input.tool_definitions, "second call may still request tools because one final call remains");
    assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["kb_1"]);
    return {
      type: "final_response",
      conversation_id: "conv_r3v",
      final_response: { final_patient_reply: "done" },
    };
  };

  const outcome = await runRuntimeBoundedModelToolLoop({
    model_state: createRuntimeModelIterationState("conv_r3v"),
    domain_state: { value: 0 },
    caller,
    model: "test-model",
    system_instruction: "system",
    message: "hello",
    initial_context: { step: 0 },
    async execute_batch({ requests, domain_state }) {
      batches++;
      return {
        kind: "continue",
        frame: {
          domain_state: { value: domain_state.value + 1 },
          context: { step: domain_state.value + 1 },
          tool_results: requests.map((request) => ({
            tool: request.tool,
            call_id: request.call_id,
            status: "success" as const,
            data: { ok: true },
          })),
          allow_tools: true,
        },
      };
    },
  });

  assert.equal(outcome.kind, "final_response");
  assert.equal(calls, 2);
  assert.equal(batches, 1);
  assert.equal(outcome.domain_state.value, 1);
  assert.equal(outcome.model_state.calls_used, 2);
});

test("R3v: final budget slot is terminal and never exposes tool definitions", async () => {
  let calls = 0;
  let batches = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    calls++;
    if (calls <= 2) {
      assert.ok(input.input.tool_definitions);
      return {
        type: "tool_requests",
        conversation_id: "conv_budget",
        tool_requests: [toolRequest(`kb_${calls}`)],
      };
    }
    assert.equal(input.input.tool_definitions, undefined, "last budget slot must be response-only");
    assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["kb_2"]);
    return {
      type: "final_response",
      conversation_id: "conv_budget",
      final_response: { final_patient_reply: "final" },
    };
  };

  const outcome = await runRuntimeBoundedModelToolLoop({
    model_state: createRuntimeModelIterationState("conv_budget"),
    domain_state: 0,
    caller,
    model: "test-model",
    system_instruction: "system",
    message: "hello",
    initial_context: {},
    async execute_batch({ requests, domain_state }) {
      batches++;
      return {
        kind: "continue",
        frame: {
          domain_state: domain_state + 1,
          context: { batch: domain_state + 1 },
          tool_results: requests.map((request) => ({
            tool: request.tool,
            call_id: request.call_id,
            status: "success" as const,
            data: { ok: true },
          })),
          allow_tools: true,
        },
      };
    },
  });

  assert.equal(outcome.kind, "final_response");
  assert.equal(calls, 3);
  assert.equal(batches, 2);
  assert.equal(outcome.model_state.calls_used, 3);
});

test("R3v: tool request returned from the terminal budget slot is observable but never executed", async () => {
  let calls = 0;
  let batches = 0;
  const caller: RuntimeAgentCaller = async () => {
    calls++;
    return {
      type: "tool_requests",
      conversation_id: "conv_exhaust",
      tool_requests: [toolRequest(`kb_${calls}`)],
    };
  };

  const outcome = await runRuntimeBoundedModelToolLoop({
    model_state: createRuntimeModelIterationState("conv_exhaust"),
    domain_state: 0,
    caller,
    model: "test-model",
    system_instruction: "system",
    message: "hello",
    initial_context: {},
    async execute_batch({ requests, domain_state }) {
      batches++;
      return {
        kind: "continue",
        frame: {
          domain_state: domain_state + 1,
          context: {},
          tool_results: requests.map((request) => ({
            tool: request.tool,
            call_id: request.call_id,
            status: "success" as const,
            data: { ok: true },
          })),
          allow_tools: true,
        },
      };
    },
  });

  assert.equal(outcome.kind, "tool_request_at_budget_limit");
  if (outcome.kind !== "tool_request_at_budget_limit") return;
  assert.equal(calls, 3);
  assert.equal(batches, 2, "third tool request must not be executed without response budget");
  assert.equal(outcome.requests[0]?.call_id, "kb_3");
});

test("R3v: terminal guard frame suppresses tool definitions and rejects another tool request", async () => {
  let calls = 0;
  let batches = 0;
  const caller: RuntimeAgentCaller = async (input) => {
    calls++;
    if (calls === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_guard",
        tool_requests: [toolRequest("kb_guard")],
      };
    }
    assert.equal(input.input.tool_definitions, undefined, "terminal guard call must be response-only");
    return {
      type: "tool_requests",
      conversation_id: "conv_guard",
      tool_requests: [toolRequest("kb_illegal")],
    };
  };

  const outcome = await runRuntimeBoundedModelToolLoop({
    model_state: createRuntimeModelIterationState("conv_guard"),
    domain_state: 0,
    caller,
    model: "test-model",
    system_instruction: "system",
    message: "hello",
    initial_context: {},
    async execute_batch({ requests, domain_state }) {
      batches++;
      return {
        kind: "continue",
        frame: {
          domain_state: domain_state + 1,
          context: {},
          tool_results: requests.map((request) => ({
            tool: request.tool,
            call_id: request.call_id,
            status: "success" as const,
            data: { guarded: true },
          })),
          allow_tools: false,
        },
      };
    },
  });

  assert.equal(outcome.kind, "terminal_tool_request");
  assert.equal(calls, 2);
  assert.equal(batches, 1);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  appendAgentFirstSystemInstruction,
  getRuntimeAgentMode,
  resolveRuntimeModelCallBudget,
} from "../src/runtime/agentFirstRuntimePolicy.ts";
import { runRuntimeBoundedModelToolLoop } from "../src/runtime/runtimeBoundedModelToolLoop.ts";
import { createRuntimeModelIterationState } from "../src/runtime/runtimeModelIteration.ts";
import type { RuntimeAgentCaller } from "../src/runtime/runtimeModelCall.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

function withAgentMode<T>(mode: string | undefined, fn: () => Promise<T> | T): Promise<T> | T {
  const previousMode = process.env.RUNTIME_AGENT_MODE;
  const previousBudget = process.env.RUNTIME_AGENT_MAX_MODEL_CALLS;
  if (mode === undefined) delete process.env.RUNTIME_AGENT_MODE;
  else process.env.RUNTIME_AGENT_MODE = mode;
  delete process.env.RUNTIME_AGENT_MAX_MODEL_CALLS;

  const restore = () => {
    if (previousMode === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previousMode;
    if (previousBudget === undefined) delete process.env.RUNTIME_AGENT_MAX_MODEL_CALLS;
    else process.env.RUNTIME_AGENT_MAX_MODEL_CALLS = previousBudget;
  };

  try {
    const value = fn();
    if (value instanceof Promise) return value.finally(restore);
    restore();
    return value;
  } catch (error) {
    restore();
    throw error;
  }
}

test("agent-first policy is opt-in and legacy budget remains 3", () => {
  assert.equal(getRuntimeAgentMode({}), "legacy");
  assert.equal(resolveRuntimeModelCallBudget({}), 3);
  assert.equal(appendAgentFirstSystemInstruction("BASE"), "BASE");
});

test("agent-first policy defaults to six model calls and supports bounded override", () => {
  assert.equal(getRuntimeAgentMode({ RUNTIME_AGENT_MODE: "agent_first" }), "agent_first");
  assert.equal(resolveRuntimeModelCallBudget({ RUNTIME_AGENT_MODE: "agent_first" }), 6);
  assert.equal(resolveRuntimeModelCallBudget({
    RUNTIME_AGENT_MODE: "agent_first",
    RUNTIME_AGENT_MAX_MODEL_CALLS: "8",
  }), 8);
  assert.equal(resolveRuntimeModelCallBudget({
    RUNTIME_AGENT_MODE: "agent_first",
    RUNTIME_AGENT_MAX_MODEL_CALLS: "99",
  }), 6);
});

test("agent-first instruction explicitly gives recovery ownership to the model", () => {
  return withAgentMode("agent_first", () => {
    const instruction = appendAgentFirstSystemInstruction("BASE");
    assert.match(instruction, /You own the conversation, planning, clarification and recovery/);
    assert.match(instruction, /blocked or failed tool action is not automatically the end of the turn/);
    assert.match(instruction, /Never claim a real-world action succeeded until the corresponding tool confirms it/);
  });
});

test("legacy loop treats allow_tools=false as terminal", async () => {
  await withAgentMode("legacy", async () => {
    let modelCalls = 0;
    let batchCalls = 0;
    const caller: RuntimeAgentCaller = async () => {
      modelCalls += 1;
      return {
        type: "tool_requests",
        conversation_id: "conv_legacy",
        tool_requests: [{ tool: "kb.search", call_id: `c${modelCalls}`, arguments: { query: "x" } }],
      };
    };

    const outcome = await runRuntimeBoundedModelToolLoop({
      model_state: createRuntimeModelIterationState(null, 4),
      domain_state: { n: 0 },
      caller,
      model: "test-model",
      system_instruction: "test",
      message: "test",
      initial_context: {},
      async execute_batch({ requests, domain_state }) {
        batchCalls += 1;
        const result: RuntimeAgentToolResult = {
          tool: requests[0].tool,
          call_id: requests[0].call_id,
          status: "success",
          data: { ok: true },
        };
        return {
          kind: "continue",
          frame: {
            domain_state: { n: domain_state.n + 1 },
            context: {},
            tool_results: [result],
            allow_tools: false,
          },
        };
      },
    });

    assert.equal(outcome.kind, "terminal_tool_request");
    assert.equal(modelCalls, 2);
    assert.equal(batchCalls, 1);
  });
});

test("agent-first loop can recover with another tool batch after allow_tools=false", async () => {
  await withAgentMode("agent_first", async () => {
    let modelCalls = 0;
    let batchCalls = 0;
    const caller: RuntimeAgentCaller = async () => {
      modelCalls += 1;
      if (modelCalls <= 2) {
        return {
          type: "tool_requests",
          conversation_id: "conv_agent_first",
          tool_requests: [{
            tool: modelCalls === 1 ? "kb.search" : "availability.check",
            call_id: `c${modelCalls}`,
            arguments: modelCalls === 1 ? { query: "price" } : { requested_date: "2026-08-24" },
          }],
        };
      }
      return {
        type: "final_response",
        conversation_id: "conv_agent_first",
        final_response: { final_patient_reply: "Recovered" },
      };
    };

    const outcome = await runRuntimeBoundedModelToolLoop({
      model_state: createRuntimeModelIterationState(null, 4),
      domain_state: { n: 0 },
      caller,
      model: "test-model",
      system_instruction: "test",
      message: "test",
      initial_context: {},
      async execute_batch({ requests, domain_state }) {
        batchCalls += 1;
        const result: RuntimeAgentToolResult = {
          tool: requests[0].tool,
          call_id: requests[0].call_id,
          status: "success",
          data: { ok: true },
        };
        return {
          kind: "continue",
          frame: {
            domain_state: { n: domain_state.n + 1 },
            context: {},
            tool_results: [result],
            allow_tools: false,
          },
        };
      },
    });

    assert.equal(outcome.kind, "final_response");
    assert.equal(modelCalls, 3);
    assert.equal(batchCalls, 2);
    assert.equal(outcome.domain_state.n, 2);
  });
});

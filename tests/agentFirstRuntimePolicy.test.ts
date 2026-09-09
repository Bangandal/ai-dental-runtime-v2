import test from "node:test";
import assert from "node:assert/strict";

import {
  isAgentFirstRuntimeEnabled,
  resolveRuntimeModelCallBudget,
  resolveRuntimeSystemInstruction,
} from "../src/runtime/agentFirstRuntimePolicy.ts";
import { runRuntimeBoundedModelToolLoop } from "../src/runtime/runtimeBoundedModelToolLoop.ts";
import { createRuntimeModelIterationState } from "../src/runtime/runtimeModelIteration.ts";
import type { RuntimeAgentCaller } from "../src/runtime/runtimeModelCall.ts";
import type { RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

const BASE = [
  "## ROLE",
  "You are the AI Front Desk agent for a dental clinic.",
  "Today is 2026-08-22 (timezone: Europe/Prague). Final patient reply must be in the patient's language.",
].join("\n");

test("runtime has one canonical agent-first mode", () => {
  assert.equal(isAgentFirstRuntimeEnabled(), true);
  assert.equal(resolveRuntimeModelCallBudget({}), 6);
  assert.equal(resolveRuntimeModelCallBudget({ RUNTIME_AGENT_MAX_MODEL_CALLS: "8" }), 8);
  assert.equal(resolveRuntimeModelCallBudget({ RUNTIME_AGENT_MAX_MODEL_CALLS: "99" }), 6);
});

test("canonical instruction gives recovery ownership to the model without old intake script", () => {
  const instruction = resolveRuntimeSystemInstruction(BASE);
  assert.match(instruction, /If a useful action is possible, take it/);
  assert.match(instruction, /On failure, use the structured recovery truth or ask the necessary clarification/);
  assert.match(instruction, /Confirm an action only from its execution result/);
});

test("bounded loop may recover with another tool batch after a guarded action", async () => {
  let modelCalls = 0;
  let batchCalls = 0;
  const caller: RuntimeAgentCaller = async () => {
    modelCalls += 1;
    if (modelCalls <= 2) {
      return {
        type: "tool_requests",
        conversation_id: "conv_runtime",
        tool_requests: [{
          tool: modelCalls === 1 ? "kb.search" : "availability.check",
          call_id: `c${modelCalls}`,
          arguments: modelCalls === 1 ? { query: "price" } : { requested_date: "2026-08-24" },
        }],
      };
    }
    return {
      type: "final_response",
      conversation_id: "conv_runtime",
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

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  invokeRuntimeModelCall,
  type RuntimeAgentCallerInput,
} from "../src/runtime/runtimeModelCall.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

test("R3m: model call preserves conversation id when caller omits one", async () => {
  const outcome = await invokeRuntimeModelCall({
    caller: async () => ({
      type: "final_response",
      final_response: { final_patient_reply: "ok" },
    }),
    model: "test-model",
    conversation_id: "conv_existing",
    system_instruction: "system",
    message: "hello",
    context: { a: 1 },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.conversation_id, "conv_existing");
  assert.equal(outcome.output.type, "final_response");
});

test("R3m: model call accepts caller conversation-id replacement including null", async () => {
  const replaced = await invokeRuntimeModelCall({
    caller: async () => ({
      type: "tool_requests",
      conversation_id: "conv_next",
      tool_requests: [],
    }),
    model: "test-model",
    conversation_id: "conv_old",
    system_instruction: "system",
    message: "hello",
    context: {},
  });
  assert.equal(replaced.ok, true);
  if (replaced.ok) assert.equal(replaced.conversation_id, "conv_next");

  const cleared = await invokeRuntimeModelCall({
    caller: async () => ({
      type: "final_response",
      conversation_id: null,
      final_response: { final_patient_reply: "done" },
    }),
    model: "test-model",
    conversation_id: "conv_old",
    system_instruction: "system",
    message: "hello",
    context: {},
  });
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.conversation_id, null);
});

test("R3m: transport boundary preserves optional tool protocol fields exactly", async () => {
  const captured: RuntimeAgentCallerInput[] = [];
  const caller = async (input: RuntimeAgentCallerInput) => {
    captured.push(input);
    return {
      type: "final_response" as const,
      final_response: { final_patient_reply: "ok" },
    };
  };

  await invokeRuntimeModelCall({
    caller,
    model: "test-model",
    conversation_id: null,
    system_instruction: "system",
    message: "without tools",
    context: {},
  });
  await invokeRuntimeModelCall({
    caller,
    model: "test-model",
    conversation_id: "conv",
    system_instruction: "system",
    message: "with tools",
    context: { grounded: true },
    tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    tool_results: [{ tool: "kb.search", call_id: "c1", status: "success", data: { chunks: [] } }],
  });

  assert.equal("tool_definitions" in captured[0].input, false);
  assert.equal("tool_results" in captured[0].input, false);
  assert.equal(captured[1].input.tool_definitions, RUNTIME_AGENT_TOOL_DEFINITIONS);
  assert.equal(captured[1].input.tool_results?.[0]?.call_id, "c1");
});

test("R3m: caller exceptions become typed failure outcomes without changing conversation id", async () => {
  const error = new Error("upstream failed");
  const outcome = await invokeRuntimeModelCall({
    caller: async () => { throw error; },
    model: "test-model",
    conversation_id: "conv_safe",
    system_instruction: "system",
    message: "hello",
    context: {},
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error, error);
  assert.equal(outcome.conversation_id, "conv_safe");
});

test("R3m structure: legacy loop delegates every direct model invocation to one boundary", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.equal(
    loopSource.match(/invokeRuntimeModelCall\(\{/g)?.length,
    6,
    "main, second, two forced finalizers, and two guarded finalizers must share one transport boundary",
  );
  assert.doesNotMatch(loopSource, /await deps\.caller\(/);
  assert.match(loopSource, /export type \{ RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput \} from ["']\.\/runtimeModelCall\.ts["']/);
});

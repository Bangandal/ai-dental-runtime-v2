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

test("R3m: transport boundary preserves conversation id returned by caller", async () => {
  const outcome = await invokeRuntimeModelCall({
    caller: async () => ({
      type: "final_response" as const,
      conversation_id: "conv_new",
      final_response: { final_patient_reply: "ok" },
    }),
    model: "test-model",
    conversation_id: "conv_old",
    system_instruction: "system",
    message: "hello",
    context: {},
  });

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.conversation_id, "conv_new");
});

test("R3m: transport boundary preserves prior conversation id when caller omits replacement", async () => {
  const outcome = await invokeRuntimeModelCall({
    caller: async () => ({
      type: "final_response" as const,
      final_response: { final_patient_reply: "ok" },
    }),
    model: "test-model",
    conversation_id: "conv_old",
    system_instruction: "system",
    message: "hello",
    context: {},
  });

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.conversation_id, "conv_old");
});

test("R3m: transport boundary can explicitly clear conversation id", async () => {
  const outcome = await invokeRuntimeModelCall({
    caller: async () => ({
      type: "final_response" as const,
      conversation_id: null,
      final_response: { final_patient_reply: "ok" },
    }),
    model: "test-model",
    conversation_id: "conv_old",
    system_instruction: "system",
    message: "hello",
    context: {},
  });

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.conversation_id, null);
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

test("R3v structure: bounded iterator owns main model transport while terminal helpers retain canonical boundary", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const iteratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeBoundedModelToolLoop.ts"), "utf8");
  const orchestratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelToolOrchestrator.ts"), "utf8");
  const helperBoundary = loopSource.indexOf("// ── Multiple-blocked booking.apply helper");
  assert.ok(helperBoundary > 0);

  const mainRunTurn = loopSource.slice(0, helperBoundary);
  const terminalHelpers = loopSource.slice(helperBoundary);

  assert.equal(mainRunTurn.match(/invokeRuntimeModelIteration\(\{/g)?.length ?? 0, 0);
  assert.equal(mainRunTurn.match(/invokeRuntimeModelCall\(\{/g)?.length ?? 0, 0);
  assert.equal(
    mainRunTurn.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length,
    1,
    "legacy shell must delegate the whole main model/tool sequence to one orchestrator",
  );
  assert.equal(
    iteratorSource.match(/invokeRuntimeModelIteration\(\{/g)?.length,
    1,
    "generic bounded iterator must be the single main iteration transport owner",
  );
  assert.match(orchestratorSource, /runRuntimeBoundedModelToolLoop\(\{/);
  assert.equal(
    terminalHelpers.match(/invokeRuntimeModelCall\(\{/g)?.length,
    2,
    "terminal compatibility helpers may still use the canonical one-call transport boundary",
  );
  assert.doesNotMatch(loopSource, /await deps\.caller\(/);
  assert.match(loopSource, /export type \{ RuntimeAgentCaller, RuntimeAgentCallerInput, RuntimeAgentCallerOutput \} from ["']\.\/runtimeModelCall\.ts["']/);
});

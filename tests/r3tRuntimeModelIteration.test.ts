import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRuntimeModelIterationState,
  invokeRuntimeModelIteration,
} from "../src/runtime/runtimeModelIteration.ts";

const COMMON = {
  model: "test-model",
  system_instruction: "system",
  message: "hello",
  context: {},
};

test("R3t: model iteration updates conversation id and increments attempted call count", async () => {
  const initial = createRuntimeModelIterationState("conv_old", 3);
  const outcome = await invokeRuntimeModelIteration({
    state: initial,
    caller: async () => ({
      type: "final_response" as const,
      conversation_id: "conv_new",
      final_response: { final_patient_reply: "ok" },
    }),
    ...COMMON,
  });

  assert.equal(outcome.kind, "model_output");
  assert.equal(outcome.state.calls_used, 1);
  assert.equal(outcome.state.max_calls, 3);
  assert.equal(outcome.state.conversation_id, "conv_new");
  assert.equal(initial.calls_used, 0, "iteration state is advanced immutably");
});

test("R3t: failed model invocation still consumes budget and preserves conversation state", async () => {
  const error = new Error("upstream failed");
  const outcome = await invokeRuntimeModelIteration({
    state: createRuntimeModelIterationState("conv_safe", 3),
    caller: async () => { throw error; },
    ...COMMON,
  });

  assert.equal(outcome.kind, "call_failed");
  assert.equal(outcome.state.calls_used, 1);
  assert.equal(outcome.state.conversation_id, "conv_safe");
  if (outcome.kind === "call_failed") assert.equal(outcome.error, error);
});

test("R3t: exhausted budget prevents an additional caller invocation", async () => {
  let callerCalls = 0;
  let state = createRuntimeModelIterationState("conv_budget", 2);

  for (let i = 0; i < 2; i++) {
    const outcome = await invokeRuntimeModelIteration({
      state,
      caller: async () => {
        callerCalls++;
        return {
          type: "final_response" as const,
          conversation_id: "conv_budget",
          final_response: { final_patient_reply: "ok" },
        };
      },
      ...COMMON,
    });
    assert.equal(outcome.kind, "model_output");
    state = outcome.state;
  }

  const exhausted = await invokeRuntimeModelIteration({
    state,
    caller: async () => {
      callerCalls++;
      throw new Error("must not be called");
    },
    ...COMMON,
  });

  assert.equal(exhausted.kind, "budget_exhausted");
  assert.equal(exhausted.state.calls_used, 2);
  assert.equal(callerCalls, 2);
});

test("R3t: invalid model-call budget fails at state construction", () => {
  assert.throws(() => createRuntimeModelIterationState(null, 0), /positive integer/);
  assert.throws(() => createRuntimeModelIterationState(null, 1.5), /positive integer/);
});

test("R3t structure: the main runTurn shell uses one bounded iteration transport state", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const helperBoundary = loopSource.indexOf("// ── Multiple-blocked booking.apply helper");
  assert.ok(helperBoundary > 0);
  const runTurnSource = loopSource.slice(0, helperBoundary);

  assert.match(runTurnSource, /createRuntimeModelIterationState\(conversationId\)/);
  assert.equal(
    runTurnSource.match(/invokeRuntimeModelIteration\(\{/g)?.length,
    3,
    "first, second, and bounded terminal model steps must share the iteration budget owner",
  );
  assert.doesNotMatch(
    runTurnSource,
    /invokeRuntimeModelCall\(\{/,
    "main runTurn path must not bypass the bounded iteration state",
  );
});

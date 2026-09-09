import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveRuntimeSystemInstruction,
} from "../src/runtime/agentFirstRuntimePolicy.ts";
import { invokeRuntimeModelIteration } from "../src/runtime/runtimeModelIteration.ts";
import type { RuntimeAgentCaller } from "../src/runtime/runtimeModelCall.ts";

const LEGACY_PROMPT = [
  "## ROLE",
  "You are the AI Front Desk agent for a dental clinic.",
  "Today is 2026-08-22 (timezone: Europe/Prague). Final patient reply must be in the patient's language.",
  "## INTAKE FLOW",
  "BOOKING SEQUENCE: availability.check → booking.select_slot → booking.apply.",
  "booking.select_slot is mandatory before booking.apply.",
  "NON-RED-FLAG tooth pain / toothache + booking intent: service = 'осмотр из-за боли'.",
].join("\n");

function withMode<T>(mode: "legacy" | "agent_first", fn: () => Promise<T> | T): Promise<T> | T {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = mode;
  const restore = () => {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  };

  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("legacy keeps the historical prompt unchanged", () => {
  const resolved = resolveRuntimeSystemInstruction(LEGACY_PROMPT, { RUNTIME_AGENT_MODE: "legacy" });
  assert.equal(resolved, LEGACY_PROMPT);
});

test("agent-first replaces legacy scripted intake instead of appending an override", () => {
  const resolved = resolveRuntimeSystemInstruction(LEGACY_PROMPT, { RUNTIME_AGENT_MODE: "agent_first" });

  assert.notEqual(resolved, LEGACY_PROMPT);
  assert.match(resolved, /Today is 2026-08-22 \(timezone: Europe\/Prague\)/);
  assert.match(resolved, /Interpret the entire message in conversation context/);
  assert.match(resolved, /If material ambiguity prevents action, ask one precise clarification/);
  assert.match(resolved, /call booking\.apply/);

  assert.doesNotMatch(resolved, /## INTAKE FLOW/);
  assert.doesNotMatch(resolved, /BOOKING SEQUENCE:/);
  assert.doesNotMatch(resolved, /booking\.select_slot is mandatory/);
  assert.doesNotMatch(resolved, /service = 'осмотр из-за боли'/);
});

test("clean agent-first prompt does not invent clinic qualification routes", () => {
  const resolved = resolveRuntimeSystemInstruction(LEGACY_PROMPT, { RUNTIME_AGENT_MODE: "agent_first" });

  assert.match(resolved, /clinical routing must come only from the clinic's qualification_policy/);
  assert.match(resolved, /Do not diagnose or prescribe treatment/);
  assert.doesNotMatch(resolved, /acute_exam|emergency_exam|orthodontic_consultation/);
});

test("model iteration sends only the clean prompt in agent-first mode", async () => {
  await withMode("agent_first", async () => {
    let capturedInstruction = "";
    const caller: RuntimeAgentCaller = async (input) => {
      capturedInstruction = input.system_instruction;
      return {
        type: "final_response",
        conversation_id: "conv_clean",
        final_response: { final_patient_reply: "Готово" },
      };
    };

    const result = await invokeRuntimeModelIteration({
      state: { conversation_id: null, calls_used: 0, max_calls: 2 },
      caller,
      model: "test-model",
      system_instruction: LEGACY_PROMPT,
      message: "test",
      context: {},
    });

    assert.equal(result.kind, "model_output");
    assert.equal(
      capturedInstruction,
      resolveRuntimeSystemInstruction(LEGACY_PROMPT, { RUNTIME_AGENT_MODE: "agent_first" }),
    );
    assert.match(capturedInstruction, /2\. INTENT/);
    assert.doesNotMatch(capturedInstruction, /Final patient reply/);
    assert.doesNotMatch(capturedInstruction, /## INTAKE FLOW/);
    assert.doesNotMatch(capturedInstruction, /booking\.select_slot is mandatory/);
  });
});

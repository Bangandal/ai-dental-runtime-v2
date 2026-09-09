import test from "node:test";
import assert from "node:assert/strict";

import { resolveRuntimeSystemInstruction } from "../src/runtime/agentFirstRuntimePolicy.ts";
import { invokeRuntimeModelIteration } from "../src/runtime/runtimeModelIteration.ts";
import type { RuntimeAgentCaller } from "../src/runtime/runtimeModelCall.ts";

const BASE_PROMPT = [
  "## ROLE",
  "You are the AI Front Desk agent for a dental clinic.",
  "Today is 2026-08-22 (timezone: Europe/Prague). Final patient reply must be in the patient's language.",
  "## INTAKE FLOW",
  "BOOKING SEQUENCE: availability.check → booking.select_slot → booking.apply.",
  "booking.select_slot is mandatory before booking.apply.",
  "NON-RED-FLAG tooth pain / toothache + booking intent: service = 'осмотр из-за боли'.",
].join("\n");

test("runtime replaces historical scripted intake with one clean instruction", () => {
  const resolved = resolveRuntimeSystemInstruction(BASE_PROMPT);
  assert.notEqual(resolved, BASE_PROMPT);
  assert.match(resolved, /Today is 2026-08-22 \(timezone: Europe\/Prague\)/);
  assert.match(resolved, /Interpret the entire message in conversation context/);
  assert.match(resolved, /If material ambiguity prevents action, ask one precise clarification/);
  assert.match(resolved, /call booking\.apply/);
  assert.doesNotMatch(resolved, /## INTAKE FLOW/);
  assert.doesNotMatch(resolved, /BOOKING SEQUENCE:/);
  assert.doesNotMatch(resolved, /booking\.select_slot is mandatory/);
});

test("clean prompt does not invent clinic qualification routes", () => {
  const resolved = resolveRuntimeSystemInstruction(BASE_PROMPT);
  assert.match(resolved, /clinical routing must come only from the clinic's qualification_policy/);
  assert.match(resolved, /Do not diagnose or prescribe treatment/);
  assert.doesNotMatch(resolved, /acute_exam|emergency_exam|orthodontic_consultation/);
});

test("model iteration sends only the canonical clean prompt", async () => {
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
    system_instruction: BASE_PROMPT,
    message: "test",
    context: {},
  });

  assert.equal(result.kind, "model_output");
  assert.equal(capturedInstruction, resolveRuntimeSystemInstruction(BASE_PROMPT));
  assert.match(capturedInstruction, /2\. INTENT/);
  assert.doesNotMatch(capturedInstruction, /## INTAKE FLOW/);
  assert.doesNotMatch(capturedInstruction, /booking\.select_slot is mandatory/);
});

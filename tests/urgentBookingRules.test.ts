import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";

const instruction = buildRuntimeAgentSystemInstruction();

test("A: system instruction contains URGENT SYMPTOM section header", () => {
  assert.ok(
    instruction.includes("URGENT SYMPTOM"),
    "Expected 'URGENT SYMPTOM' in system instruction",
  );
});

test("B: system instruction contains 'осмотр из-за боли' inferred service", () => {
  assert.ok(
    instruction.includes("осмотр из-за боли"),
    "Expected 'осмотр из-за боли' in system instruction",
  );
});

test("C: system instruction says do not ask formal service when symptom + booking intent present", () => {
  const lower = instruction.toLowerCase();
  assert.ok(
    lower.includes("do not ask the patient to name a formal service"),
    "Expected rule about not asking formal service when symptom is present",
  );
});

test("D: system instruction maps urgency expressions to nearest available slot check", () => {
  assert.ok(
    instruction.includes("как можно скорее"),
    "Expected 'как можно скорее' in system instruction",
  );
  assert.ok(
    instruction.includes("nearest available"),
    "Expected 'nearest available' in system instruction",
  );
});

test("E: system instruction maps 'да давай' affirmation to availability.check continuation", () => {
  assert.ok(
    instruction.includes("да давай"),
    "Expected 'да давай' in system instruction",
  );
  assert.ok(
    instruction.includes("availability.check"),
    "Expected 'availability.check' in system instruction",
  );
});

test("F: system instruction mentions tooth pain symptom list", () => {
  assert.ok(
    instruction.includes("tooth pain"),
    "Expected 'tooth pain' in symptom list",
  );
  assert.ok(
    instruction.includes("toothache"),
    "Expected 'toothache' in symptom list",
  );
});

test("G: system instruction maps срочно / ASAP to urgency handling", () => {
  assert.ok(
    instruction.includes("срочно"),
    "Expected 'срочно' in urgency list",
  );
  assert.ok(
    instruction.includes("ASAP"),
    "Expected 'ASAP' in urgency list",
  );
});

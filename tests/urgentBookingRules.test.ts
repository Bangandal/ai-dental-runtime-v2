import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";

const instruction = buildRuntimeAgentSystemInstruction();

test("A: system instruction contains 'осмотр из-за боли' inferred service for tooth pain", () => {
  assert.ok(
    instruction.includes("осмотр из-за боли"),
    "Expected 'осмотр из-за боли' in system instruction",
  );
});

test("B: system instruction says do not ask formal service when non-red-flag tooth pain + booking intent", () => {
  const lower = instruction.toLowerCase();
  assert.ok(
    lower.includes("do not ask the patient to name a formal service"),
    "Expected rule about not asking formal service when symptom is present",
  );
});

test("C: system instruction maps urgency expressions to nearest available slot check", () => {
  assert.ok(
    instruction.includes("как можно скорее"),
    "Expected 'как можно скорее' in system instruction",
  );
  assert.ok(
    instruction.includes("nearest available"),
    "Expected 'nearest available' in system instruction",
  );
});

test("D: system instruction maps 'да давай' affirmation to availability.check continuation", () => {
  assert.ok(
    instruction.includes("да давай"),
    "Expected 'да давай' in system instruction",
  );
  assert.ok(
    instruction.includes("availability.check"),
    "Expected 'availability.check' in system instruction",
  );
});

test("E: red-flag symptoms (bleeding) appear in RED-FLAG section, not normal inference", () => {
  assert.ok(
    instruction.includes("RED-FLAG"),
    "Expected 'RED-FLAG' section in system instruction",
  );
  const redFlagIdx = instruction.indexOf("RED-FLAG");
  const bleedingIdx = instruction.indexOf("bleeding");
  assert.ok(
    bleedingIdx > -1,
    "Expected 'bleeding' to appear in system instruction",
  );
  // bleeding must appear after RED-FLAG (in the red-flag block), not before NON-RED-FLAG
  const nonRedFlagIdx = instruction.indexOf("NON-RED-FLAG");
  assert.ok(
    bleedingIdx < nonRedFlagIdx,
    "Expected 'bleeding' to appear in RED-FLAG block, before NON-RED-FLAG section",
  );
});

test("F: red-flag symptoms (swelling) appear in RED-FLAG section, not normal inference", () => {
  const redFlagIdx = instruction.indexOf("RED-FLAG");
  const swellingIdx = instruction.indexOf("swelling");
  assert.ok(
    swellingIdx > -1,
    "Expected 'swelling' to appear in system instruction",
  );
  const nonRedFlagIdx = instruction.indexOf("NON-RED-FLAG");
  assert.ok(
    swellingIdx < nonRedFlagIdx,
    "Expected 'swelling' to appear in RED-FLAG block, before NON-RED-FLAG section",
  );
});

test("G: system instruction contains explicit RED-FLAG / NON-RED-FLAG separation", () => {
  assert.ok(
    instruction.includes("RED-FLAG"),
    "Expected 'RED-FLAG' in system instruction",
  );
  assert.ok(
    instruction.includes("NON-RED-FLAG"),
    "Expected 'NON-RED-FLAG' in system instruction",
  );
});

test("H: NON-RED-FLAG path is explicitly scoped to tooth pain / toothache", () => {
  assert.ok(
    instruction.includes("NON-RED-FLAG tooth pain"),
    "Expected 'NON-RED-FLAG tooth pain' scoping in system instruction",
  );
  assert.ok(
    instruction.includes("toothache"),
    "Expected 'toothache' in NON-RED-FLAG path",
  );
});

test("I: system instruction maps срочно / ASAP to urgency handling", () => {
  assert.ok(
    instruction.includes("срочно"),
    "Expected 'срочно' in urgency list",
  );
  assert.ok(
    instruction.includes("ASAP"),
    "Expected 'ASAP' in urgency list",
  );
});

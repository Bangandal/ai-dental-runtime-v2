import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";
import { projectModelPersonInstruction } from "../src/runtime/modelPersonIntentBridge.ts";

test("R3g: canonical runtime prompt contains semantic BOOKING PEOPLE protocol", () => {
  const instruction = buildRuntimeAgentSystemInstruction({
    now: new Date("2026-08-21T12:00:00Z"),
    timezone: "Europe/Prague",
  });

  assert.match(instruction, /## BOOKING PEOPLE/);
  assert.equal(instruction.match(/## BOOKING PEOPLE/g)?.length, 1, "semantic people protocol must have exactly one canonical prompt section");
  assert.match(instruction, /target:"self"\|"active"\|"other_person"/);
  assert.match(instruction, /person_ref:null\|string/);
  assert.match(instruction, /subject_intent.*final_response/is);
  assert.match(instruction, /phone_ownership_intent.*final_response/is);
  assert.match(instruction, /Never emit subject_id/);
  assert.ok(instruction.length <= 6474, `canonical prompt exceeded the 50% budget: ${instruction.length}`);
});

test("R3g: canonical runtime prompt no longer contains legacy BOOKING SUBJECTS protocol", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.doesNotMatch(instruction, /## BOOKING SUBJECTS/);
  assert.doesNotMatch(instruction, /subject_1=sender\/self/);
  assert.doesNotMatch(instruction, /subject_id:null\|subject_N/);
  assert.doesNotMatch(instruction, /target_subject_id:null\|subject_N/);
});

test("R3g: model-person prompt projection is identity for the canonical prompt", () => {
  const instruction = buildRuntimeAgentSystemInstruction();
  assert.equal(projectModelPersonInstruction(instruction), instruction);
});

test("R3g: model-person prompt projection never appends hidden protocol to arbitrary instructions", () => {
  assert.equal(projectModelPersonInstruction("system"), "system");
});

test("R3g structure: person-intent bridge no longer owns a second prompt protocol", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const bridgeSource = await readFile(resolve(thisDir, "../src/runtime/modelPersonIntentBridge.ts"), "utf8");

  assert.doesNotMatch(bridgeSource, /SEMANTIC_PERSON_PROTOCOL/);
  assert.doesNotMatch(bridgeSource, /startMarker\s*=\s*["']## BOOKING SUBJECTS/);
  assert.doesNotMatch(bridgeSource, /systemInstruction\.slice\(/);
});

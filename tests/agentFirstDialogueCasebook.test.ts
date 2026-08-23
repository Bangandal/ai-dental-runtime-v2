import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentFirstSystemInstruction } from "../src/runtime/agentFirstSystemInstruction.ts";

interface DialogueCase {
  id: string;
  title: string;
  patient_messages: string[];
  runtime_setup: string[];
  expected: {
    model_should: string[];
    model_must_not: string[];
    required_tools: string[];
    forbidden_tools: string[];
  };
}

interface DialogueCasebook {
  version: string;
  mode: string;
  purpose: string;
  architecture_invariants: string[];
  cases: DialogueCase[];
}

async function loadCasebook(): Promise<DialogueCasebook> {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(resolve(here, "../evals/agent-first-dialogue-casebook-v1.json"), "utf8");
  return JSON.parse(raw) as DialogueCasebook;
}

const MODEL_FACING_TOOLS = new Set([
  "kb.search",
  "availability.check",
  "booking.apply",
  "appointment.lookup",
]);

const REQUIRED_INVARIANTS = [
  "model_owns_conversation_strategy",
  "runtime_owns_external_truth",
  "conversation_memory_is_not_reality",
  "historical_booking_evidence_is_not_current_availability",
  "user_intent_is_not_write_permission",
  "model_inference_is_not_external_fact",
];

const REQUIRED_CASES = [
  "D01_GREETING_ONLY",
  "D02_PRICE_THEN_BOOKING",
  "D03_EXACT_TIME_REQUEST",
  "D04_VAGUE_TIME_WINDOW",
  "D05_CLOSED_DAY_AUTO_EXTEND",
  "D06_STALE_SLOT_SELECTION",
  "D07_MISSING_NAME_RECOVERY",
  "D08_SLOT_CONFLICT_RECOVERY",
  "D09_EXISTING_APPOINTMENT",
  "D10_MULTI_PERSON_AMBIGUITY",
  "D11_COMPLAINT_QUALIFICATION",
  "D12_CORRECTION_MID_FLOW",
  "D13_LANGUAGE_CONTINUITY",
  "D14_NO_SIDE_EFFECT_CLAIM",
];

test("agent-first dialogue casebook is semantic, complete and non-scripted", async () => {
  const casebook = await loadCasebook();

  assert.equal(casebook.version, "1.0");
  assert.equal(casebook.mode, "semantic_behavior");
  assert.match(casebook.purpose, /without prescribing exact wording or a fixed dialogue state machine/i);
  assert.deepEqual(casebook.architecture_invariants, REQUIRED_INVARIANTS);

  const ids = casebook.cases.map((entry) => entry.id);
  assert.deepEqual(ids, REQUIRED_CASES);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be unique");

  for (const entry of casebook.cases) {
    assert.ok(entry.patient_messages.length > 0, `${entry.id} must contain patient input`);
    assert.ok(entry.runtime_setup.length > 0, `${entry.id} must define relevant Runtime setup`);
    assert.ok(entry.expected.model_should.length > 0, `${entry.id} must define positive semantic behavior`);
    assert.ok(entry.expected.model_must_not.length > 0, `${entry.id} must define negative semantic behavior`);

    for (const tool of entry.expected.required_tools) {
      assert.ok(MODEL_FACING_TOOLS.has(tool), `${entry.id} requires non-model-facing tool ${tool}`);
    }
    assert.ok(
      !entry.expected.required_tools.includes("booking.select_slot"),
      `${entry.id} must not make hidden booking.select_slot part of the model contract`,
    );
  }
});

test("casebook covers every model-facing clinic action at least once", async () => {
  const casebook = await loadCasebook();
  const required = new Set(casebook.cases.flatMap((entry) => entry.expected.required_tools));

  assert.equal(required.has("kb.search"), true);
  assert.equal(required.has("availability.check"), true);
  assert.equal(required.has("booking.apply"), true);
  assert.equal(required.has("appointment.lookup"), true);
});

test("Prompt 2.0 exposes the architecture needed by the casebook without scripting the cases", () => {
  const instruction = buildAgentFirstSystemInstruction(
    "Today is 2026-08-23 (timezone: Europe/Prague). Final patient reply must be in the patient's language.",
  );

  assert.match(instruction, /You own the conversation, planning, clarification and recovery/i);
  assert.match(instruction, /Runtime\/tool results own external truth and boundaries/i);
  assert.match(instruction, /Conversation history is evidence of what was said and intended, not proof of current clinic reality/i);
  assert.match(instruction, /Historical booking evidence or previously mentioned slots/i);
  assert.match(instruction, /availability_presentation_truth/i);
  assert.match(instruction, /resolved_date\/resolved_calendar/i);
  assert.match(instruction, /appointment_display_truth/i);
  assert.match(instruction, /qualification_policy/i);
  assert.match(instruction, /pending typed phone/i);
  assert.doesNotMatch(instruction, /PATH A|PATH B|D01_|D02_|D03_|D04_/);
});

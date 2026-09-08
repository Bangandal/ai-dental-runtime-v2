import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentFirstSystemInstruction } from "../src/runtime/agentFirstSystemInstruction.ts";
import { resolveRuntimeSystemInstruction } from "../src/runtime/agentFirstRuntimePolicy.ts";

const LEGACY = [
  "## ROLE",
  "Today is 2026-08-23 (timezone: Europe/Prague). Final patient reply must be in the patient's language. Never reply in English unless the patient wrote in English.",
  "## INTAKE FLOW",
  "PATH A — greeting",
  "PATH B — hard-coded routing",
  "BOOKING SEQUENCE: availability.check → booking.select_slot → booking.apply.",
].join("\n");

function prompt(): string {
  return buildAgentFirstSystemInstruction(LEGACY);
}

test("Prompt 2.0 is goal-oriented rather than a scripted dialogue router", () => {
  const instruction = prompt();

  assert.match(instruction, /Help the patient accomplish their current task/i);
  assert.match(instruction, /Interpret the entire message in conversation context/i);
  assert.match(instruction, /previous question and the current booking stage do not determine the meaning/i);
  assert.doesNotMatch(instruction, /PATH A|PATH B|B1\.|B2\.|B3\.|B4\.|B5\./);
});

test("Prompt 2.0 keeps model strategy separate from Runtime external truth", () => {
  const instruction = prompt();

  assert.match(instruction, /kb\.search.*appointment\.lookup/i);
  assert.match(instruction, /History establishes what was said; current tool results establish the clinic's current state/i);
  assert.match(instruction, /Runtime determines its current validity/i);
  assert.match(instruction, /Confirm an action only from its execution result/i);
});

test("Prompt 2.0 has one language rule and inherits only the Runtime clock", () => {
  const instruction = prompt();

  assert.match(instruction, /^Today is 2026-08-23 \(timezone: Europe\/Prague\)\.$/m);
  assert.match(instruction, /Reply briefly and naturally in the patient's language/i);
  assert.match(instruction, /switch only when the patient clearly switches/i);
  assert.doesNotMatch(instruction, /Final patient reply|Never reply in English/i);
  assert.equal(
    buildAgentFirstSystemInstruction("Today is 2026-08-23 (timezone: Europe/Prague)."),
    instruction,
  );
});

test("Prompt 2.0 uses only availability_presentation_truth for patient-facing slot display", () => {
  const instruction = prompt();

  assert.match(instruction, /Show only options authorized by current availability_presentation_truth/i);
  assert.match(instruction, /allowed_slots\/allowed_slot_starts/);
  assert.match(instruction, /max_slots_to_present/);
  assert.doesNotMatch(instruction, /availability_presentation_truth\/current availability evidence/i);
});

test("Prompt 2.0 distinguishes historical slot selection evidence from current availability claims", () => {
  const instruction = prompt();

  assert.match(instruction, /previously offered slot may be submitted for validation/i);
  assert.match(instruction, /Runtime determines its current validity/i);
  assert.match(instruction, /Show only options authorized by current availability_presentation_truth/i);
});

test("Prompt 2.0 requires explicit delivery proof before notification or handoff claims", () => {
  const instruction = prompt();

  assert.match(instruction, /Only structured delivery proof with status sent permits claiming delivery to staff/i);
  assert.match(instruction, /queued is not delivered/i);
  assert.match(instruction, /delivery does not mean a doctor has acted/i);
});

test("Prompt 2.0 uses Runtime resolved calendar truth for alternative dates", () => {
  const instruction = prompt();

  assert.match(instruction, /availability_presentation_truth.*resolved_date\/resolved_calendar/i);
  assert.match(instruction, /Use Runtime's calendar values/i);
});

test("Prompt 2.0 scopes appointment display truth to confirmed booking actions", () => {
  const instruction = prompt();

  assert.match(instruction, /appointment_display_truth is authoritative only when Runtime provides it after a confirmed booking action/i);
  assert.match(instruction, /existing appointments come from appointment\.lookup/i);
});

test("Prompt 2.0 keeps hidden booking ceremony out of the agent-first model", () => {
  const instruction = prompt();

  assert.match(instruction, /chooses an exact offered slot.*call booking\.apply/i);
  assert.doesNotMatch(instruction, /booking\.select_slot/i);
  assert.doesNotMatch(instruction, /BOOKING SEQUENCE:/i);
});

test("Prompt 2.0 preserves policy-owned clinical routing", () => {
  const instruction = prompt();

  assert.match(instruction, /Urgency, red flags and clinical routing must come only from the clinic's qualification_policy/i);
  assert.match(instruction, /if no qualification_policy is present in context, omit route, urgency and red_flags/i);
  assert.match(instruction, /Do not diagnose or prescribe treatment/i);
  assert.doesNotMatch(instruction, /acute_exam|emergency_exam|orthodontic_consultation/i);
});

test("Prompt 2.0 never turns a doctor contact request into a callback", () => {
  const instruction = prompt();

  assert.match(instruction, /Never disclose a doctor's direct or personal contact details/i);
  assert.match(instruction, /request for a doctor's phone number, email or other direct contact is not a callback request/i);
  assert.match(instruction, /do not create a staff_request solely from that request/i);
  assert.match(instruction, /explicitly asks a doctor or administrator to call them.*staff_request\.kind=callback/i);
});

test("Prompt 2.0 asks the model to persist patient facts, not its own summary", () => {
  const instruction = prompt();

  assert.match(instruction, /qualification: complaint \(without diagnosis\) and reported_facts/i);
  assert.doesNotMatch(instruction, /qualification:.*summary/i);
});

test("legacy mode remains byte-for-byte unchanged", () => {
  assert.equal(
    resolveRuntimeSystemInstruction(LEGACY, { RUNTIME_AGENT_MODE: "legacy" }),
    LEGACY,
  );
});

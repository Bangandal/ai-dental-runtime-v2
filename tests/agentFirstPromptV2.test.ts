import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentFirstSystemInstruction } from "../src/runtime/agentFirstSystemInstruction.ts";
import { resolveRuntimeSystemInstruction } from "../src/runtime/agentFirstRuntimePolicy.ts";

const LEGACY = [
  "## ROLE",
  "Today is 2026-08-23 (timezone: Europe/Prague). Final patient reply must be in the patient's language.",
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

  assert.match(instruction, /understand what the patient is trying to accomplish/i);
  assert.match(instruction, /Choose the conversational path from the patient's actual intent and context/i);
  assert.match(instruction, /do not force a fixed questionnaire, fixed field order or scripted branch/i);
  assert.doesNotMatch(instruction, /PATH A|PATH B|B1\.|B2\.|B3\.|B4\.|B5\./);
});

test("Prompt 2.0 keeps model strategy separate from Runtime external truth", () => {
  const instruction = prompt();

  assert.match(instruction, /You own the conversation, planning, clarification and recovery/i);
  assert.match(instruction, /Runtime\/tool results own external truth and boundaries/i);
  assert.match(instruction, /current availability, calendar truth, patient identity resolution, booking legality and confirmed write outcomes/i);
  assert.match(instruction, /Conversation history is evidence of what was said and intended, not proof of current clinic reality/i);
});

test("Prompt 2.0 preserves conversation language across short neutral replies and tool output", () => {
  const instruction = prompt();

  assert.match(instruction, /Maintain the conversation language from the patient's latest substantive language-bearing message/i);
  assert.match(instruction, /Short or language-neutral replies such as confirmations, dates, times, names or acknowledgements do not change language/i);
  assert.match(instruction, /Never switch language because a tool result, KB content, Runtime label or example uses another language/i);
  assert.match(instruction, /switch only when the patient clearly switches/i);
});

test("Prompt 2.0 uses only availability_presentation_truth for patient-facing slot display", () => {
  const instruction = prompt();

  assert.match(instruction, /Patient-facing slot display may come only from current availability_presentation_truth/i);
  assert.match(instruction, /Present only its allowed_slots\/allowed_slot_starts and respect max_slots_to_present/i);
  assert.match(instruction, /If availability_presentation_truth is absent, do not present slots/i);
  assert.match(instruction, /Raw availability tool output is not patient-facing display authority/i);
  assert.doesNotMatch(instruction, /availability_presentation_truth\/current availability evidence/i);
});

test("Prompt 2.0 distinguishes historical slot selection evidence from current availability claims", () => {
  const instruction = prompt();

  assert.match(instruction, /Historical booking evidence or previously mentioned slots may help interpret which slot the patient selected/i);
  assert.match(instruction, /never permission to claim that a slot is currently available/i);
  assert.match(instruction, /previously offered slot may be treated as a booking choice/i);
  assert.match(instruction, /Runtime remains responsible for deciding whether the stored booking evidence is still valid/i);
  assert.match(instruction, /unless current availability_presentation_truth authorizes that claim/i);
});

test("Prompt 2.0 requires explicit delivery proof before notification or handoff claims", () => {
  const instruction = prompt();

  assert.match(instruction, /Never claim an administrator was notified, a handoff happened, or staff will contact the patient/i);
  assert.match(instruction, /structured delivery proof confirms that the notification or handoff side effect was actually created or queued/i);
  assert.match(instruction, /admin_handoff is a requested next step, not delivery proof/i);
});

test("Prompt 2.0 uses Runtime resolved calendar truth for alternative dates", () => {
  const instruction = prompt();

  assert.match(instruction, /availability_presentation_truth provides resolved_date\/resolved_calendar/i);
  assert.match(instruction, /use that resolved date and calendar label for returned slots and for the booking action/i);
  assert.match(instruction, /Never attach returned times to an older requested_date/i);
});

test("Prompt 2.0 uses appointment display truth instead of model weekday arithmetic", () => {
  const instruction = prompt();

  assert.match(instruction, /appointment_display_truth/i);
  assert.match(instruction, /displayed date, time and weekday/i);
  assert.match(instruction, /Do not calculate or invent a weekday/i);
});

test("Prompt 2.0 keeps hidden booking ceremony out of the agent-first model", () => {
  const instruction = prompt();

  assert.match(instruction, /call booking\.apply directly/i);
  assert.match(instruction, /booking\.select_slot is an internal Runtime detail/i);
  assert.doesNotMatch(instruction, /booking\.select_slot is mandatory/i);
  assert.doesNotMatch(instruction, /BOOKING SEQUENCE:/i);
});

test("Prompt 2.0 preserves policy-owned clinical routing", () => {
  const instruction = prompt();

  assert.match(instruction, /Clinical red flags, urgency categories and routing decisions may only come from an explicit clinic-provided qualification_policy/i);
  assert.match(instruction, /Do not invent a clinical route/i);
  assert.doesNotMatch(instruction, /acute_exam|emergency_exam|orthodontic_consultation/i);
});

test("legacy mode remains byte-for-byte unchanged", () => {
  assert.equal(
    resolveRuntimeSystemInstruction(LEGACY, { RUNTIME_AGENT_MODE: "legacy" }),
    LEGACY,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeAgentSystemInstruction, RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

// Original prompt char count (measured before the prompt diet refactor on branch ai-dental-frontdesk-core HEAD 9e82e44).
// PROMPT-13 verifies that these were removed (>=50% reduction).
const ORIGINAL_SIZE_CHARS = 12949;

// Build a stable prompt snapshot for all tests (date pinned, no firstTurnRule).
const PROMPT = buildRuntimeAgentSystemInstruction({
  now: new Date("2026-08-13T09:00:00Z"),
  timezone: "Europe/Prague",
  is_new_conversation: false,
});

test("PROMPT-1: prompt contains clinic role line", () => {
  assert.ok(
    PROMPT.includes("AI Front Desk agent for a dental clinic") ||
      PROMPT.includes("dental clinic"),
    "Expected a role line identifying this as a dental clinic agent",
  );
});

test("PROMPT-2: prompt contains today's date and timezone placeholder", () => {
  assert.match(PROMPT, /Today is \d{4}-\d{2}-\d{2}/);
  assert.ok(PROMPT.includes("Europe/Prague") || PROMPT.includes("timezone"), "Expected timezone reference");
});

test("PROMPT-3: booking sequence includes booking.select_slot before booking.apply", () => {
  assert.ok(PROMPT.includes("availability.check"), "Expected availability.check in prompt");
  assert.ok(PROMPT.includes("booking.select_slot"), "Expected booking.select_slot in prompt");
  assert.ok(PROMPT.includes("booking.apply"), "Expected booking.apply in prompt");
  // booking.select_slot must appear before booking.apply
  const selectIdx = PROMPT.indexOf("booking.select_slot");
  const applyIdx = PROMPT.indexOf("booking.apply");
  assert.ok(selectIdx < applyIdx, "booking.select_slot must appear before booking.apply");
  // No shortcut bypassing booking.select_slot
  assert.ok(
    !PROMPT.includes("name + service + slot are all known"),
    "Prompt must not contain the old shortcut 'name+service+slot are all known -> booking.apply'",
  );
});

test("PROMPT-4: prompt contains subject_intent schema reference", () => {
  assert.ok(PROMPT.includes("subject_intent"), "Expected subject_intent JSON schema reference");
  assert.ok(
    PROMPT.includes("action") && PROMPT.includes("confidence"),
    "Expected subject_intent schema fields (action, confidence)",
  );
});

test("PROMPT-5: prompt contains phone_ownership_intent schema reference", () => {
  assert.ok(PROMPT.includes("phone_ownership_intent"), "Expected phone_ownership_intent JSON schema reference");
  assert.ok(PROMPT.includes("assign_pending_phone"), "Expected assign_pending_phone action in schema");
});

test("PROMPT-6: prompt references availability_action_truth", () => {
  assert.ok(PROMPT.includes("availability_action_truth"), "Expected availability_action_truth reference");
});

test("PROMPT-7: prompt references booking_apply_action_truth", () => {
  assert.ok(PROMPT.includes("booking_apply_action_truth"), "Expected booking_apply_action_truth reference");
});

test("PROMPT-8: prompt references appointment_display_truth", () => {
  assert.ok(PROMPT.includes("appointment_display_truth"), "Expected appointment_display_truth reference");
});

test("PROMPT-9: prompt does NOT enumerate all four phone_source enum values as a trust taxonomy", () => {
  const hasTrustTaxonomy =
    PROMPT.includes("telegram_contact_button") &&
    PROMPT.includes("whatsapp_sender") &&
    PROMPT.includes("manual_input") &&
    PROMPT.includes("existing_cliniccard_patient");
  assert.ok(
    !hasTrustTaxonomy,
    "Prompt should not enumerate all four phone_source enum values as a trust taxonomy",
  );
});

test("PROMPT-10: required_next_action is referenced (interface) but enum values are NOT individually mapped", () => {
  assert.ok(
    PROMPT.includes("required_next_action"),
    "Prompt must reference required_next_action — model must know to follow it",
  );
  // Individual booking state-machine enum values must not appear as per-value instructions
  const enumValues = ["visit_created", "booking_confirmed", "slot_not_verified", "missing_name", "missing_service", "missing_slot"];
  const foundValues = enumValues.filter(v => PROMPT.includes(v));
  assert.ok(
    foundValues.length === 0,
    `Prompt must not enumerate booking required_next_action values individually. Found: ${foundValues.join(", ")}`,
  );
});

test("PROMPT-11: prompt does NOT contain booking_write_disabled runtime status", () => {
  assert.ok(
    !PROMPT.includes("booking_write_disabled"),
    "booking_write_disabled is a runtime-owned status, not a model instruction",
  );
});

test("PROMPT-12: prompt does NOT use TRUSTED/UNTRUSTED as instructional labels", () => {
  assert.ok(
    !PROMPT.includes("TRUSTED phone") && !PROMPT.includes("UNTRUSTED phone"),
    "TRUSTED/UNTRUSTED instructional labels should not appear — runtime enforces trust, model does not decide",
  );
});

test("PROMPT-13: prompt size is >=50% smaller than the pre-refactor original", () => {
  const maxAllowed = Math.floor(ORIGINAL_SIZE_CHARS * 0.50);
  assert.ok(
    PROMPT.length <= maxAllowed,
    `Prompt is ${PROMPT.length} chars but must be <=${maxAllowed} (50% of original ${ORIGINAL_SIZE_CHARS}, i.e. >=50% reduction). Actual reduction: ${((ORIGINAL_SIZE_CHARS - PROMPT.length) / ORIGINAL_SIZE_CHARS * 100).toFixed(1)}%`,
  );
});

test("PROMPT-14: prompt is a non-empty string", () => {
  assert.equal(typeof PROMPT, "string");
  assert.ok(PROMPT.length > 0, "Prompt must not be empty");
});

test("PROMPT-15: prompt does NOT require availability evidence only from the current turn", () => {
  // PR #188 intentionally allows fresh, runtime-sanitized availability across adjacent turns (TTL guard).
  assert.ok(
    !PROMPT.includes("from this turn"),
    "Prompt must not require availability evidence 'from this turn' — runtime TTL guard handles staleness",
  );
});

test("PROMPT-16: prompt forbids resurrecting slots from prose conversation history", () => {
  assert.ok(
    PROMPT.includes("prose conversation history") || PROMPT.includes("prose history"),
    "Prompt must explicitly forbid resurrecting availability from prose history",
  );
});

test("PROMPT-17: booking_apply_action_truth references both allowed_claims and required_next_action", () => {
  assert.ok(PROMPT.includes("booking_apply_action_truth"), "Expected booking_apply_action_truth reference");
  assert.ok(PROMPT.includes("allowed_claims"), "Expected allowed_claims in booking_apply_action_truth context");
  assert.ok(PROMPT.includes("required_next_action"), "Expected required_next_action in booking_apply_action_truth context");
});

test("PROMPT-18: required_next_action enum values are NOT individually listed as per-value instructions", () => {
  // Model is told to follow required_next_action, not taught each possible booking state-machine value.
  const bookingEnumValues = ["ask_for_phone", "visit_created", "booking_confirmed", "slot_not_verified", "missing_name", "missing_service"];
  const found = bookingEnumValues.filter(v => PROMPT.includes(v));
  assert.ok(
    found.length === 0,
    `Prompt must not enumerate booking required_next_action values. Found: ${found.join(", ")}`,
  );
});

test("PROMPT-19: availability_presentation_truth owns allowed_slot_starts and max_slots_to_present", () => {
  assert.ok(PROMPT.includes("availability_presentation_truth"), "Expected availability_presentation_truth reference");
  assert.ok(PROMPT.includes("allowed_slot_starts"), "Expected allowed_slot_starts reference");
  assert.ok(PROMPT.includes("max_slots_to_present"), "Expected max_slots_to_present reference");
  // availability_presentation_truth should appear before (or near) these fields
  const presIdx = PROMPT.indexOf("availability_presentation_truth");
  const slotsIdx = PROMPT.lastIndexOf("allowed_slot_starts");
  const maxIdx = PROMPT.indexOf("max_slots_to_present");
  assert.ok(presIdx < slotsIdx, "availability_presentation_truth should appear before allowed_slot_starts");
  assert.ok(presIdx < maxIdx, "availability_presentation_truth should appear before max_slots_to_present");
});

test("PROMPT-20: prompt contains appointment.lookup semantic routing rule", () => {
  assert.ok(PROMPT.includes("appointment.lookup"), "Expected appointment.lookup routing in prompt");
});

test("PROMPT-21: prompt does NOT document 'disabled' as an availability_action_truth outcome", () => {
  // AvailabilityOutcome type values: slots_available, no_slots, past_date, technical_failure, denied.
  // 'disabled' is NOT a valid AvailabilityOutcome.
  assert.ok(
    !PROMPT.includes("disabled: online booking cannot complete"),
    "Prompt must not document 'disabled' as an availability outcome — not in AvailabilityOutcome type",
  );
});

test("PROMPT-22: system prompt does NOT prohibit tool calls merely because tool_results are present", () => {
  assert.ok(
    !PROMPT.includes("do not request additional tools"),
    "Prompt must not absolutely prohibit tool calls when tool_results are present"
  );
  assert.ok(
    PROMPT.includes("next valid step") || PROMPT.includes("another tool only when required"),
    "Prompt must allow tool requests when required for a valid next step"
  );
});

test("PROMPT-23: affirmation after date-specific offer preserves offered date", () => {
  assert.ok(
    PROMPT.match(/affirmation|offered.*check|preserving.*date|context date/i) !== null,
    "Prompt must instruct that affirmation after an offered check preserves the offered date"
  );
});

test("PROMPT-24: ASAP rule does not list bare affirmations as ASAP triggers", () => {
  const asapLine = PROMPT.split("\n").find(l => l.startsWith("ASAP ("));
  if (asapLine) {
    assert.ok(
      !asapLine.includes("'да'"),
      "ASAP rule must not unconditionally list bare 'да' as an ASAP trigger"
    );
  }
});

test("PROMPT-25: RED-FLAG guidance includes a patient action, not only model restrictions", () => {
  const redFlagLine = PROMPT.split("\n").find(l => l.startsWith("RED-FLAG"));
  assert.ok(redFlagLine, "RED-FLAG line must exist");
  assert.ok(
    redFlagLine!.includes("contact") || redFlagLine!.includes("emergency") || redFlagLine!.includes("urgently") || redFlagLine!.includes("care"),
    "RED-FLAG must include a patient action (contact clinic, seek emergency care, etc.)"
  );
});

test("PROMPT-26: subject_intent schema includes display_name, count, and labels for create_subjects semantics", () => {
  assert.ok(PROMPT.includes("display_name"), "subject_intent schema must include display_name");
  assert.ok(PROMPT.includes("count"), "subject_intent schema must include count");
  assert.ok(PROMPT.includes("labels"), "subject_intent schema must include labels");
});

test("PROMPT-27: booking.apply tool description does not require channel-captured phone specifically", () => {
  const desc = RUNTIME_AGENT_TOOL_DEFINITIONS["booking.apply"].description;
  assert.ok(
    !desc.includes("channel has captured") && !desc.includes("captured their phone"),
    "booking.apply must not require channel-captured phone specifically"
  );
  assert.ok(
    desc.includes("acceptable booking contact") || desc.includes("booking contact"),
    "booking.apply should refer generically to acceptable booking contact"
  );
});


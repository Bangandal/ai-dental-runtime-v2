import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";

// Original prompt char count (measured before the prompt diet refactor on branch ai-dental-frontdesk-core HEAD 9e82e44).
// The previous prompt had more verbose sections including:
//   - untested subject_id examples ('Запишите меня' → subject_id='subject_1', etc.)
//   - "Each subject has: id, label, patient_name, service..." field docs
//   - subject_intent examples in Russian
//   - "When booking_status=pending_phone_classification..." duplicate note
//   - "selected_slot and last_available_slots are reliable" (now runtime-sanitized via TTL guard)
//   - "When sources conflict: higher-ranked source wins." filler
//   - NON-RED-FLAG intake sub-bullets (Service, Time) duplicating TRIAGE and TOOLS sections
// PROMPT-13 verifies that these were removed (≥50% reduction).
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

test("PROMPT-3: prompt contains booking sequence keywords", () => {
  assert.ok(PROMPT.includes("availability.check"), "Expected availability.check in booking sequence");
  assert.ok(PROMPT.includes("booking.apply"), "Expected booking.apply in booking sequence");
  assert.ok(PROMPT.includes("INTAKE"), "Expected INTAKE FLOW section with booking sequence");
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
  // Runtime enforces phone trust in bookingApplyExecutor; the model should not be instructed
  // to decide trust levels based on raw enum values. The prompt may reference contact methods
  // in human-readable form (Telegram contact button) but not enumerate all four enum values together.
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

test("PROMPT-10: prompt does NOT enumerate required_next_action values with per-value instructions", () => {
  assert.ok(
    !PROMPT.includes("required_next_action"),
    "Prompt should not contain required_next_action mapping — runtime sets this deterministically",
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

test("PROMPT-13: prompt size is ≥50% smaller than the pre-refactor original", () => {
  // Target ≥50% reduction from baseline. Runtime-owned content (phone trust, booking
  // state-machine mappings, channel UI details) removed from prompt — covered by runtime tests.
  const maxAllowed = Math.floor(ORIGINAL_SIZE_CHARS * 0.50); // ≤50% of original = ≥50% reduction
  assert.ok(
    PROMPT.length <= maxAllowed,
    `Prompt is ${PROMPT.length} chars but must be ≤${maxAllowed} (50% of original ${ORIGINAL_SIZE_CHARS}, i.e. ≥50% reduction). Actual reduction: ${((ORIGINAL_SIZE_CHARS - PROMPT.length) / ORIGINAL_SIZE_CHARS * 100).toFixed(1)}%`,
  );
});

test("PROMPT-14: prompt is a non-empty string", () => {
  assert.equal(typeof PROMPT, "string");
  assert.ok(PROMPT.length > 0, "Prompt must not be empty");
});

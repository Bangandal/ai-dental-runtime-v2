/**
 * Focused contract tests for the simplified runtime system prompt.
 * Each test verifies one of the 10 essential model responsibilities without
 * asserting the full prompt verbatim — so prompt wording can evolve while
 * the behavioural contracts remain guarded.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";

const instruction = buildRuntimeAgentSystemInstruction();
const instructionNew = buildRuntimeAgentSystemInstruction({ is_new_conversation: true });

describe("Essential prompt contracts (simplified prompt — PR #181)", () => {
  // Contract 1: Reply in the patient's language
  test("C1: prompt requires reply in patient language, never English unless patient wrote English", () => {
    assert.match(instruction, /patient'?s language/i, "must instruct model to reply in patient language");
    assert.match(instruction, /Never reply in English unless the patient wrote in English/i);
  });

  // Contract 2: Understand intent and collect missing booking info flexibly
  test("C2: prompt instructs flexible intent collection without rigid order", () => {
    assert.match(instruction, /collect missing details flexibly/i);
    assert.match(instruction, /fallback, not a strict order/i);
    assert.match(instruction, /ask only for what is genuinely missing/i);
  });

  // Contract 3: Correct tool selection rules present
  test("C3: prompt names all three active tools with their purpose", () => {
    assert.match(instruction, /kb\.search/i);
    assert.match(instruction, /availability\.check/i);
    assert.match(instruction, /booking\.apply/i);
    assert.match(instruction, /clinic FAQ|services.*prices|opening hours/i, "kb.search purpose");
    assert.match(instruction, /available.*slot|slot.*available/i, "availability.check purpose");
    assert.match(instruction, /create a visit|confirmed slot/i, "booking.apply purpose");
  });

  // Contract 4: subject_id always required in booking.apply
  test("C4: prompt states subject_id is always required in booking.apply", () => {
    assert.match(instruction, /subject_id.*ALWAYS required|ALWAYS.*subject_id/i);
    assert.match(instruction, /subject_1.*sender.*self|sender.*self.*subject_1/i, "subject_1 = sender/self");
    assert.match(instruction, /subject_2.*first other person|first other person.*subject_2/i);
    assert.match(instruction, /Never call booking\.apply without subject_id/i);
  });

  // Contract 5: subject_intent and phone_ownership_intent emission
  test("C5: prompt instructs model to emit subject_intent and phone_ownership_intent", () => {
    assert.match(instruction, /subject_intent/i, "must mention subject_intent");
    assert.match(instruction, /phone_ownership_intent/i, "must mention phone_ownership_intent");
    assert.match(instruction, /SUBJECT INTENT|subject_intent.*final_response/i, "must explain when to include subject_intent");
    assert.match(instruction, /PHONE OWNERSHIP INTENT|phone_ownership_intent.*final_response/i, "must explain phone_ownership_intent format");
  });

  // Contract 6: obey booking_apply_action_truth, appointment_display_truth
  test("C6: prompt instructs model to follow booking_apply_action_truth strictly", () => {
    assert.match(instruction, /booking_apply_action_truth.*present.*follow.*strictly|follow.*booking_apply_action_truth.*strictly/i);
    assert.match(instruction, /appointment_display_truth/i, "must reference appointment_display_truth");
    assert.match(instruction, /can_say_booking_created=false/i, "must specify what to do when booking claim is forbidden");
  });

  // Contract 7: never claim availability without tool evidence
  test("C7: prompt prohibits availability claims without tool evidence", () => {
    assert.match(instruction, /Never claim.*slot.*time.*day available without availability\.check|never claim.*available.*without/i);
    assert.match(instruction, /Never claim a slot\/time\/day available without availability\.check results from this turn/i);
  });

  // Contract 8: never claim booking created/confirmed when truth forbids it
  test("C8: prompt guards against booking claims when truth object forbids them", () => {
    assert.match(instruction, /do NOT claim appointment was created/i, "must prohibit booking-created claim when can_say_booking_created=false");
    assert.match(instruction, /do NOT claim appointment is confirmed/i, "must prohibit booking-confirmed claim when can_say_booking_confirmed=false");
    assert.match(instruction, /Do not claim booking is confirmed without explicit backend proof/i, "must guard against unproven booking confirmation");
  });

  // Contract 9: natural patient-facing text — no raw JSON or internal terms
  test("C9: prompt instructs natural language final reply", () => {
    assert.match(instruction, /Final patient reply must be in the patient'?s language/i);
    // Ensure the prompt doesn't instruct model to output internal field names directly
    assert.doesNotMatch(instruction, /output raw JSON in.*final_patient_reply/i);
  });

  // Contract 10: final-response schema
  test("C10: prompt references the required final-response schema fields", () => {
    // final_patient_reply is the output field — prompt refers to it as "final patient reply" in prose
    assert.match(instruction, /final patient reply|final_response/i, "must reference the final response the model must produce");
    assert.match(instruction, /subject_intent/i, "must reference subject_intent output field");
    assert.match(instruction, /phone_ownership_intent/i, "must reference phone_ownership_intent output field");
    // Both intent fields must be placed inside final_response JSON
    assert.match(instruction, /include.*subject_intent.*final_response|include.*phone_ownership_intent.*final_response/is,
      "must instruct model to place intent fields inside final_response JSON");
  });

  // Removed content: no duplicated runtime guard narrative
  test("SIMPLIFIED: BOOKING PROCESS STATE next_action_confidence block is removed", () => {
    assert.doesNotMatch(
      instruction,
      /next_action_confidence='high': strong signal/i,
      "verbose BOOKING PROCESS STATE block must be removed from simplified prompt",
    );
    assert.doesNotMatch(
      instruction,
      /BOOKING PROCESS STATE: hint only/i,
      "BOOKING PROCESS STATE header must not appear verbatim",
    );
  });

  test("SIMPLIFIED: redundant SOURCE OF TRUTH line removed from BOOKING FLOW", () => {
    // The phrase still appears in CONTEXT AUTHORITY — check it doesn't also appear
    // as a standalone duplicated footer in BOOKING FLOW
    const bfStart = instruction.indexOf("## BOOKING FLOW");
    const afterBF = bfStart > -1 ? instruction.slice(bfStart) : "";
    assert.doesNotMatch(
      afterBF,
      /SOURCE OF TRUTH: Tool results and booking_apply_action_truth are authoritative\. Conversation history is dialogue evidence only\./,
      "duplicate SOURCE OF TRUTH footer must be removed from BOOKING FLOW",
    );
  });

  test("SIMPLIFIED: CS and EN locale subject_id examples removed (rule stated once)", () => {
    assert.doesNotMatch(
      instruction,
      /Examples \(CS\)/i,
      "CS locale examples removed — rule stated once with RU examples",
    );
    assert.doesNotMatch(
      instruction,
      /Examples \(EN\)/i,
      "EN locale examples removed — rule stated once with RU examples",
    );
  });

  // Confirm essential safety phrases still present after simplification
  test("SIMPLIFIED: essential NEVER rules still present after simplification", () => {
    assert.match(instruction, /Do not invent prices, services, opening hours, availability, bookings/i);
    assert.match(instruction, /never call typed phone trusted/i);
    assert.match(instruction, /typed phone is acceptable/i);
    assert.match(instruction, /unverified booking contact/i);
    assert.match(instruction, /unless a handoff or admin notification side effect was actually created or queued/i);
    assert.match(instruction, /unless a notification or handoff side effect was actually created or queued/i);
  });

  // Confirm first-turn routing still present when is_new_conversation=true
  test("SIMPLIFIED: first-turn routing paths A and B still present", () => {
    assert.match(instructionNew, /PATH A/i);
    assert.match(instructionNew, /PATH B/i);
    assert.match(instructionNew, /помощник администратора клиники/i);
    assert.match(instructionNew, /Do NOT claim to be a human administrator/i);
  });
});

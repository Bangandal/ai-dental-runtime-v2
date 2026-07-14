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

  // Contract 6: obey all three model-visible truth contracts
  test("C6: prompt instructs model to follow all three truth contracts", () => {
    // booking_apply_action_truth
    assert.match(instruction, /booking_apply_action_truth.*present.*follow.*strictly|follow.*booking_apply_action_truth.*strictly/i);
    assert.match(instruction, /can_say_booking_created=false/i, "must specify what to do when booking claim is forbidden");
    // availability_presentation_truth
    assert.match(instruction, /availability_presentation_truth/i, "must reference availability_presentation_truth");
    assert.match(instruction, /allowed_slot_starts/i, "must reference allowed_slot_starts from truth object");
    assert.match(instruction, /max_slots_to_present/i, "must reference max_slots_to_present from truth object");
    // appointment_display_truth
    assert.match(instruction, /appointment_display_truth/i, "must reference appointment_display_truth");
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
  test("C9: prompt requires natural patient-facing output and prohibits internal terminology in reply", () => {
    // Must name final_patient_reply as natural patient-facing text
    assert.match(instruction, /final_patient_reply.*natural patient-facing text|natural patient-facing text.*final_patient_reply/i,
      "must state final_patient_reply is natural patient-facing text");
    // Must prohibit raw JSON in patient reply
    assert.match(instruction, /never include raw JSON|raw JSON.*never|never.*raw JSON/i,
      "must explicitly prohibit raw JSON in the reply");
    // Must prohibit tool names in patient reply
    assert.match(instruction, /tool names.*reply|never include.*tool names/i,
      "must prohibit tool names in patient reply");
    // Must prohibit truth-object names in patient reply
    assert.match(instruction, /truth-object names|runtime-internal terminology/i,
      "must prohibit truth-object names and runtime terminology in patient reply");
    // Language rule still present
    assert.match(instruction, /Final patient reply must be in the patient'?s language/i);
  });

  // Contract 10: final-response schema — verify actual required field names
  test("C10: prompt references specific final-response field names", () => {
    // final_patient_reply must be named as a field (not just prose)
    assert.match(instruction, /\bfinal_patient_reply\b/,
      "prompt must name the final_patient_reply field explicitly");
    // subject_intent must appear in final_response JSON context
    assert.match(instruction, /subject_intent.*final_response/is,
      "subject_intent must be placed inside final_response JSON");
    // phone_ownership_intent must appear in final_response JSON context
    assert.match(instruction, /phone_ownership_intent.*final_response/is,
      "phone_ownership_intent must be placed inside final_response JSON");
    // The field name format for subject_intent must be present
    assert.match(instruction, /"action".*"none".*"switch_subject"|"switch_subject".*"create_subjects"/s,
      "subject_intent action enum values must be present");
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

  // ── Channel-aware phone wording (Point 1) ───────────────────────────────────

  test("PHONE-CHANNEL-1: ask_for_phone rule references channel_context.channel", () => {
    assert.match(instruction, /channel_context\.channel/i,
      "must instruct model to check channel_context.channel for phone capture method");
  });

  test("PHONE-CHANNEL-2: Telegram contact button only mentioned for Telegram channel", () => {
    assert.match(instruction, /telegram.*contact button appears automatically|contact button appears automatically/i,
      "telegram path must say contact button appears automatically");
    assert.match(instruction, /Never mention a Telegram contact button when channel is not telegram/i,
      "must prohibit Telegram button on non-Telegram channels");
  });

  test("PHONE-CHANNEL-3: sms/unknown channel falls back to typed phone", () => {
    assert.match(instruction, /sms.*unknown.*ask.*type|sms or unknown.*ask.*type/i,
      "sms or unknown channel must ask patient to type their number");
  });

  test("PHONE-CHANNEL-4: whatsapp/web uses native channel capture (no button)", () => {
    assert.match(instruction, /whatsapp.*web.*captured natively|whatsapp\/web.*natively/i,
      "whatsapp/web must use native channel capture");
  });

  test("PHONE-CHANNEL-5: never re-ask a phone already provided", () => {
    assert.match(instruction, /Never re-ask a phone already provided/i,
      "must prohibit re-asking an already-provided phone");
  });

  // ── availability_presentation_truth contract (Point 2) ──────────────────────

  test("APT-1: availability_presentation_truth in CONTEXT AUTHORITY", () => {
    // Must appear in CONTEXT AUTHORITY item 2 alongside other truth objects
    const caStart = instruction.indexOf("## CONTEXT AUTHORITY");
    const caEnd = instruction.indexOf("##", caStart + 1);
    const caSection = instruction.slice(caStart, caEnd > -1 ? caEnd : undefined);
    assert.ok(
      caSection.includes("availability_presentation_truth"),
      "availability_presentation_truth must be listed in CONTEXT AUTHORITY",
    );
  });

  test("APT-2: availability_presentation_truth contract specifies allowed_slot_starts and max_slots_to_present", () => {
    assert.match(instruction, /AVAILABILITY PRESENTATION TRUTH/i);
    assert.match(instruction, /allowed_slot_starts/i);
    assert.match(instruction, /max_slots_to_present/i);
    assert.match(instruction, /never.*range|range.*forbidden/i, "ranges must be forbidden");
    assert.match(instruction, /never invent times/i, "must prohibit inventing times");
  });
});

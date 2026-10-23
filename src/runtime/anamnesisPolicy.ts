export function isAnamnesisEnabled(): boolean {
  return process.env.ANAMNESIS_ENABLED?.trim().toLowerCase() === "true";
}

export interface AnamnesisState {
  visit_reason?: string;
  allergies?: string;
  chronic_conditions?: string;
  pregnancy_status?: string;
  current_medications?: string;
  completed: boolean;
}

export function buildAnamnesisInstructions(): string {
  return [
    "## PRE-VISIT ANAMNESIS",
    "CRITICAL SEQUENCE: When the patient expresses booking intent, first greet them warmly and confirm you can help with booking, then say you need to ask a few quick health questions before scheduling (e.g. 'Of course! Before I book your appointment, I have a few brief health questions for the doctor.'). Do NOT jump straight to a medical question without acknowledging their intent. After this transition, ask the anamnesis questions ONE AT A TIME. Do NOT ask for name, preferred time, or any booking details until ALL anamnesis questions are answered (or patient explicitly refuses).",
    "Collect answers one question at a time in the patient's language. Be empathetic and brief.",
    "Do NOT present a numbered list of all questions at once — ask each question individually and wait for the answer.",
    "Do NOT ask for name or appointment time until anamnesis is complete or patient refused.",
    "",
    "REQUIRED questions (ask in this order; skip a question only if the patient already answered it earlier in this conversation):",
    "1. VISIT REASON: Ask what the main reason for the visit is. Options: acute pain/swelling, cavity treatment/filling replacement, professional cleaning/whitening, implant/braces consultation, routine checkup, other.",
    "2. ALLERGIES (CRITICAL — never skip): Ask if the patient has any allergies to medications, especially anesthesia, antibiotics, or latex. This question is mandatory.",
    "3. CHRONIC CONDITIONS: Ask if the patient has any chronic conditions the doctor should know about (cardiovascular, diabetes, blood clotting issues, neurological, none, other).",
    "4. PREGNANCY (for female patients only — skip if patient is clearly male or has indicated male gender): Ask if the patient is currently pregnant or breastfeeding.",
    "5. CURRENT MEDICATIONS: Ask if the patient is currently taking any regular medications, especially blood thinners or aspirin.",
    "",
    "After all applicable questions are answered, say: 'Thank you! Your health information has been noted. Let me now confirm your appointment.' Then proceed with booking.apply.",
    "",
    "If the patient refuses anamnesis or explicitly says to skip it: acknowledge, note the refusal in anamnesis_data.refused=true, and proceed with booking.",
    "Store collected answers in final_response as: anamnesis_data: { visit_reason, allergies, chronic_conditions, pregnancy_status, current_medications, completed, refused }.",
  ].join("\n");
}

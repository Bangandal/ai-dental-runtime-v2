import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { RuntimeCaseLite, RuntimeCaseLiteUpdate } from "./runtimeCaseLite.ts";

export interface CaseLiteExtractor {
  extractCaseLiteUpdate(input: CaseLiteExtractorInput): Promise<RuntimeCaseLiteUpdate>;
}

export interface CaseLiteExtractorInput {
  user_message: string;
  existing_case: RuntimeCaseLite | null;
  locale: string | null;
}

const EXTRACTOR_INSTRUCTIONS = [
  "You are a structured case-context extractor for a dental clinic AI assistant.",
  "Extract structured meaning from the user message. Output JSON only — no prose, no markdown.",
  "Return a case update object with these fields (all optional — only include fields you can confidently extract):",
  "{",
  '  "active_intent": "booking" | "faq" | "urgent_clinical" | "unknown",',
  '  "clinical_signal": {',
  '    "level": "none" | "tooth_pain" | "red_flag",',
  '    "type": "none" | "tooth_pain" | "bleeding" | "swelling" | "fever" | "trauma" | "severe_pain" | "unknown",',
  '    "safety_guidance_first": boolean,',
  '    "must_contact_clinic_immediately": boolean,',
  '    "emergency_if_severe_or_worsening": boolean',
  "  },",
  '  "booking": {',
  '    "first_name": string | null,',
  '    "last_name": string | null,',
  '    "service_reason": string | null,',
  '    "preferred_time_text": string | null,',
  '    "preferred_time_mode": "asap" | "exact" | "datepart" | "unknown" | null',
  "  }",
  "}",
  "",
  "CLINICAL SIGNAL RULES:",
  "RED-FLAG (level=red_flag, safety_guidance_first=true, must_contact_clinic_immediately=true, emergency_if_severe_or_worsening=true):",
  "  - bleeding / кровит / кровотечение / кровь: type=bleeding",
  "  - swelling / опухло / опухла / отёк / отечность: type=swelling",
  "  - fever / температура / жар: type=fever",
  "  - trauma / травма / удар / выбил зуб: type=trauma",
  "  - severe pain / сильная боль / невыносимая боль / острая боль: type=severe_pain",
  "NON-RED-FLAG tooth pain (level=tooth_pain, safety_guidance_first=false):",
  "  - tooth hurts / болит зуб / зубная боль / ноет зуб / чувствительность: type=tooth_pain",
  "  - when tooth_pain + booking intent: set service_reason='осмотр из-за боли'",
  "NO clinical signal (level=none, type=none): all other messages",
  "",
  "BOOKING INTENT: active_intent=booking when user expresses desire to book, schedule, make an appointment.",
  "urgent_clinical: when red-flag symptom dominates with no clear booking intent.",
  "booking with red-flag: when red-flag symptom present AND booking intent present — active_intent=booking, clinical_signal.level=red_flag.",
  "",
  "NAME EXTRACTION: Extract first_name and last_name if user provides their full name (e.g. 'Роман Анбасадоров' → first_name='Роман', last_name='Анбасадоров').",
  "",
  "TIME EXTRACTION:",
  "  - 'как можно скорее', 'срочно', 'ASAP', 'побыстрее', 'чем раньше' → preferred_time_mode=asap, preferred_time_text=original phrase",
  "  - exact date/time (e.g. 'в пятницу в 15:00', 'завтра в 14:00') → preferred_time_mode=exact",
  "  - vague part-of-day (e.g. 'после обеда', 'утром') → preferred_time_mode=datepart",
  "",
  "MERGE RULES: Do not include fields the user did not mention in this message.",
  "If the user did not provide a name, do not include first_name/last_name.",
  "If you cannot confidently determine a field, omit it.",
  "",
  "Output ONLY the JSON object. Do not wrap in markdown. Do not explain.",
].join("\n");

export function createOpenAIRuntimeCaseLiteExtractor(deps: {
  client: OpenAIResponsesClient;
  model: string;
}): CaseLiteExtractor {
  return {
    async extractCaseLiteUpdate(input) {
      const payload = {
        user_message: input.user_message,
        locale: input.locale,
        existing_intent: input.existing_case?.active_intent ?? "unknown",
        existing_clinical_level: input.existing_case?.clinical_signal.level ?? "none",
      };

      const response = await deps.client.responses.create({
        model: deps.model,
        instructions: EXTRACTOR_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(payload) }],
          },
        ],
      });

      return parseExtractorOutput(response);
    },
  };
}

function parseExtractorOutput(raw: unknown): RuntimeCaseLiteUpdate {
  const obj = asObject(raw);
  const text =
    readString(obj?.output_text) ??
    readFirstOutputText(obj?.output) ??
    "";

  if (!text) return {};
  try {
    const trimmed = text.trim();
    const candidate = extractJsonCandidate(trimmed);
    const parsed = JSON.parse(candidate);
    return normalizeExtractedUpdate(parsed);
  } catch {
    return {};
  }
}

function normalizeExtractedUpdate(parsed: unknown): RuntimeCaseLiteUpdate {
  const obj = asObject(parsed);
  if (!obj) return {};

  const update: RuntimeCaseLiteUpdate = {};

  const intent = readString(obj.active_intent);
  if (intent === "booking" || intent === "faq" || intent === "urgent_clinical" || intent === "unknown") {
    update.active_intent = intent;
  }

  const clinicalRaw = asObject(obj.clinical_signal);
  if (clinicalRaw) {
    const level = readString(clinicalRaw.level);
    const type = readString(clinicalRaw.type);
    if (level === "none" || level === "tooth_pain" || level === "red_flag") {
      update.clinical_signal = {
        level,
        type: isValidClinicalType(type) ? type : "unknown",
        safety_guidance_first: Boolean(clinicalRaw.safety_guidance_first),
        must_contact_clinic_immediately: Boolean(clinicalRaw.must_contact_clinic_immediately),
        emergency_if_severe_or_worsening: Boolean(clinicalRaw.emergency_if_severe_or_worsening),
      };
    }
  }

  const bookingRaw = asObject(obj.booking);
  if (bookingRaw) {
    const booking: RuntimeCaseLiteUpdate["booking"] = {};
    const firstName = readString(bookingRaw.first_name);
    const lastName = readString(bookingRaw.last_name);
    const serviceReason = readString(bookingRaw.service_reason);
    const timeText = readString(bookingRaw.preferred_time_text);
    const timeMode = readString(bookingRaw.preferred_time_mode);

    if (firstName !== null) booking.first_name = firstName;
    if (lastName !== null) booking.last_name = lastName;
    if (serviceReason !== null) booking.service_reason = serviceReason;
    if (timeText !== null) booking.preferred_time_text = timeText;
    if (timeMode === "asap" || timeMode === "exact" || timeMode === "datepart" || timeMode === "unknown") {
      booking.preferred_time_mode = timeMode;
    }

    if (Object.keys(booking).length > 0) update.booking = booking;
  }

  return update;
}

function isValidClinicalType(value: string | null): value is
  "none" | "tooth_pain" | "bleeding" | "swelling" | "fever" | "trauma" | "severe_pain" | "unknown" {
  return value !== null && [
    "none", "tooth_pain", "bleeding", "swelling", "fever", "trauma", "severe_pain", "unknown",
  ].includes(value);
}

function readFirstOutputText(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    const obj = asObject(item);
    if (!obj || readString(obj.type) !== "message") continue;
    const content = obj.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const partObj = asObject(part);
      if (!partObj || readString(partObj.type) !== "output_text") continue;
      const text = readString(partObj.text);
      if (text) return text;
    }
  }
  return null;
}

function extractJsonCandidate(text: string): string {
  const fence = "```";
  const first = text.indexOf(fence);
  if (first === -1) return text;
  const second = text.indexOf(fence, first + fence.length);
  if (second === -1) return text;
  const body = text.slice(first + fence.length, second).trim();
  return body.startsWith("json") ? body.slice(4).trim() : body;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

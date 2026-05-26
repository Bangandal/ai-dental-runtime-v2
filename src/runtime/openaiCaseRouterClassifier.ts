import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { CaseRouterClassifier, CaseRouterClassifierInput } from "./caseRouterShadow.ts";

const CASE_ROUTER_INSTRUCTIONS = [
  "You are a shadow-only case router classifier.",
  "Classify only. Do not answer the patient.",
  "Do not decide booking execution.",
  "Do not create or update cases.",
  "Return JSON only. No markdown. No prose.",
  "Return exactly one object matching this schema:",
  "{",
  '  "case_relation": "same_case" | "new_case" | "follow_up" | "reopen_case" | "no_case" | "unknown",',
  '  "case_action": "open_case" | "reuse_case" | "no_case",',
  '  "case_type": "faq" | "booking_request" | "availability_request" | "admin_request" | "urgent" | "follow_up" | "reschedule" | "cancel" | "other",',
  '  "topic": string | null,',
  '  "status": "open" | "collecting" | "waiting_patient" | "resolved" | "cancelled" | "closed" | null,',
  '  "priority": "low" | "normal" | "high" | "urgent",',
  '  "confidence": "low" | "medium" | "high",',
  '  "reason": string,',
  '  "should_apply": false',
  "}",
  "Do not return additional keys.",
  "Do not return these keys: classification, intent, extracted_slots, action, type, booking_intent.",
  "should_apply must always be false.",
  "Examples:",
  "Price question:",
  '{"case_relation":"no_case","case_action":"no_case","case_type":"faq","topic":"cleaning price","status":"resolved","priority":"low","confidence":"high","reason":"User asks for a price only; no operational case should be opened in shadow mode.","should_apply":false}',
  "Booking request:",
  '{"case_relation":"new_case","case_action":"open_case","case_type":"booking_request","topic":"appointment booking","status":"collecting","priority":"normal","confidence":"high","reason":"User asks to schedule an appointment.","should_apply":false}',
  "Follow-up booking detail:",
  '{"case_relation":"same_case","case_action":"reuse_case","case_type":"booking_request","topic":"dental cleaning","status":"collecting","priority":"normal","confidence":"medium","reason":"User provides service details after a booking-related turn.","should_apply":false}',
  "Greeting only:",
  '{"case_relation":"no_case","case_action":"no_case","case_type":"other","topic":null,"status":null,"priority":"low","confidence":"high","reason":"Greeting only; no case action.","should_apply":false}',
].join(" ");

export function createOpenAICaseRouterClassifier(deps: { client: OpenAIResponsesClient; model: string }): CaseRouterClassifier {
  return {
    async classifyCaseTurn(input: CaseRouterClassifierInput): Promise<unknown> {
      const response = await deps.client.responses.create({
        model: deps.model,
        instructions: CASE_ROUTER_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }],
      });
      return parseClassifierOutput(response);
    },
  };
}

const MAX_DEBUG_OUTPUT_CHARS = 4_000;

class ClassifierOutputParseError extends Error {
  readonly classifier_raw_output: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.classifier_raw_output = truncateClassifierDebugOutput(rawOutput);
  }
}

function parseClassifierOutput(raw: unknown): unknown {
  const obj = asObject(raw);
  const outputText = readString(obj?.output_text);
  if (outputText) return buildClassifierDebugEnvelope(outputText);
  const output = obj?.output;
  if (!Array.isArray(output)) throw new Error("missing_classifier_output");
  for (const item of output) {
    const itemObj = asObject(item);
    if (!itemObj || readString(itemObj.type) !== "message") continue;
    const content = itemObj.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const partObj = asObject(part);
      if (!partObj || readString(partObj.type) !== "output_text") continue;
      const text = readString(partObj.text);
      if (text) return buildClassifierDebugEnvelope(text);
    }
  }
  throw new Error("missing_classifier_output");
}

export function parseClassifierJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = extractJsonCandidate(trimmed);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("invalid_classifier_json");
  }
}

function buildClassifierDebugEnvelope(rawOutput: string): {
  decision: unknown;
  classifier_raw_output: string;
  classifier_raw_parsed: unknown;
} {
  try {
    const parsed = parseClassifierJson(rawOutput);
    return {
      decision: parsed,
      classifier_raw_output: truncateClassifierDebugOutput(rawOutput),
      classifier_raw_parsed: parsed,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_classifier_json") {
      throw new ClassifierOutputParseError("invalid_classifier_json", rawOutput);
    }
    throw error;
  }
}

function truncateClassifierDebugOutput(rawOutput: string): string {
  if (rawOutput.length <= MAX_DEBUG_OUTPUT_CHARS) return rawOutput;
  return `${rawOutput.slice(0, MAX_DEBUG_OUTPUT_CHARS)}...[truncated ${rawOutput.length - MAX_DEBUG_OUTPUT_CHARS} chars]`;
}

function extractJsonCandidate(text: string): string {
  const startFence = "```";
  const firstFence = text.indexOf(startFence);
  if (firstFence === -1) return text;
  const secondFence = text.indexOf(startFence, firstFence + startFence.length);
  if (secondFence === -1) return text;
  const fencedBody = text.slice(firstFence + startFence.length, secondFence).trim();
  if (fencedBody.startsWith("json")) {
    return fencedBody.slice(4).trim();
  }
  return fencedBody;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

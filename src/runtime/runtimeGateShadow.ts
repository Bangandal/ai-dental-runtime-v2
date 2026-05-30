import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";

// Runtime Gate is the first shadow-only step of OPERATIONAL_RUNTIME_CONTOUR_v1.
// It is observability only and must not mutate state, route turns, open cases,
// decide booking details, write topic memory, or change patient-facing replies.

export type RuntimeGateRoute = "non_operational" | "operational_candidate";
export type RuntimeGateTurnShape =
  | "greeting"
  | "faq"
  | "mixed"
  | "booking"
  | "availability"
  | "slot_fragment"
  | "reschedule"
  | "cancel"
  | "urgent"
  | "admin_request"
  | "follow_up"
  | "process_status_inquiry"
  | "postpone"
  | "confirmation_response"
  | "unclear"
  | "other";
export type RuntimeGateConfidence = "low" | "medium" | "high";

export interface RuntimeGateDebug {
  enabled: true;
  mode: "shadow";
  route: RuntimeGateRoute;
  turn_shape: RuntimeGateTurnShape;
  confidence: RuntimeGateConfidence;
  reason: string;
  should_apply: false;
}

export interface RuntimeGateClassifierInput {
  user_message: string;
  runtime_context: Record<string, unknown>;
}

export interface RuntimeGateClassifier {
  classifyRuntimeGateTurn(input: RuntimeGateClassifierInput): Promise<unknown>;
}

const ROUTES: readonly RuntimeGateRoute[] = ["non_operational", "operational_candidate"];
const TURN_SHAPES: readonly RuntimeGateTurnShape[] = [
  "greeting",
  "faq",
  "mixed",
  "booking",
  "availability",
  "slot_fragment",
  "reschedule",
  "cancel",
  "urgent",
  "admin_request",
  "follow_up",
  "process_status_inquiry",
  "postpone",
  "confirmation_response",
  "unclear",
  "other",
];
const CONFIDENCES: readonly RuntimeGateConfidence[] = ["low", "medium", "high"];

const FALLBACK_REASON = "runtime gate fallback; classifier unavailable or failed";
const MAX_DEBUG_OUTPUT_CHARS = 4_000;

const RUNTIME_GATE_INSTRUCTIONS = [
  "You are a shadow-only Runtime Gate classifier for a dental frontdesk runtime.",
  "Classify only. Do not answer the patient.",
  "This signal is observability only and is not authoritative.",
  "Do not route, decide booking details, open cases, write memory, or mutate state.",
  "Return JSON only. No markdown. No prose.",
  "Return exactly one object matching this schema:",
  "{",
  '  "route": "non_operational" | "operational_candidate",',
  '  "turn_shape": "greeting" | "faq" | "mixed" | "booking" | "availability" | "slot_fragment" | "reschedule" | "cancel" | "urgent" | "admin_request" | "follow_up" | "process_status_inquiry" | "postpone" | "confirmation_response" | "unclear" | "other",',
  '  "confidence": "low" | "medium" | "high",',
  '  "reason": string,',
  '  "should_apply": false',
  "}",
  "Do not return additional keys.",
  "should_apply must always be false.",
  "Classification guidance:",
  "Greeting, thanks, simple FAQ, price, location, insurance, and general information are non_operational.",
  "Booking, availability, reschedule, cancel, urgent, admin request, follow-up, process status inquiry, postpone, confirmation response, and slot fragments after a pending question are operational_candidate.",
  "Mixed turns combining booking intent and FAQ content are operational_candidate with turn_shape mixed.",
  "Ambiguous short replies are operational_candidate as slot_fragment or unclear only when runtime_context indicates pending task or last bot question; otherwise non_operational unclear.",
  "Examples:",
  '{"route":"non_operational","turn_shape":"greeting","confidence":"high","reason":"Greeting only; no operational signal in shadow mode.","should_apply":false}',
  '{"route":"non_operational","turn_shape":"faq","confidence":"high","reason":"User asks for general pricing information only.","should_apply":false}',
  '{"route":"operational_candidate","turn_shape":"booking","confidence":"high","reason":"User asks to book an appointment.","should_apply":false}',
  '{"route":"operational_candidate","turn_shape":"mixed","confidence":"high","reason":"User combines appointment booking intent with a price question.","should_apply":false}',
].join(" ");

export function buildFallbackRuntimeGateDebug(reason = FALLBACK_REASON): RuntimeGateDebug {
  return {
    enabled: true,
    mode: "shadow",
    route: "non_operational",
    turn_shape: "unclear",
    confidence: "low",
    reason,
    should_apply: false,
  };
}

export function normalizeRuntimeGateDebug(raw: unknown): RuntimeGateDebug {
  const value = extractRuntimeGateValue(raw);
  const fallback = buildFallbackRuntimeGateDebug();
  return {
    enabled: true,
    mode: "shadow",
    route: pickOne(ROUTES, value.route, fallback.route),
    turn_shape: pickOne(TURN_SHAPES, value.turn_shape, fallback.turn_shape),
    confidence: pickOne(CONFIDENCES, value.confidence, fallback.confidence),
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : fallback.reason,
    should_apply: false,
  };
}

export async function runRuntimeGateShadow(input: {
  user_message: string;
  runtime_context: Record<string, unknown>;
  classifier?: RuntimeGateClassifier;
}): Promise<RuntimeGateDebug> {
  if (!input.classifier) {
    return buildFallbackRuntimeGateDebug("runtime gate fallback; classifier not connected");
  }
  try {
    const result = await input.classifier.classifyRuntimeGateTurn({
      user_message: input.user_message,
      runtime_context: input.runtime_context,
    });
    const classifierValue = extractRuntimeGateValue(result);
    if (!isValidRuntimeGateClassifierValue(classifierValue)) {
      return buildFallbackRuntimeGateDebug("runtime gate fallback; invalid classifier output");
    }
    return normalizeRuntimeGateDebug(classifierValue);
  } catch {
    return buildFallbackRuntimeGateDebug();
  }
}

export function sanitizeRuntimeGateContext(rawRuntimeContext: unknown): Record<string, unknown> {
  const root = asRecord(rawRuntimeContext);
  const taskState = asRecord(root.task_state);
  const conversationState = asRecord(root.conversation_state);
  const bookingContext = asRecord(root.booking_context);
  const caseContext = asRecord(root.case_context);
  return {
    task_state: {
      missing_fields: readStringArray(taskState.missing_fields).length > 0 ? readStringArray(taskState.missing_fields) : readStringArray(conversationState.missing_fields),
      last_known_intent: readString(taskState.last_known_intent) ?? readString(conversationState.intent),
      intake_status: readString(taskState.intake_status) ?? readString(conversationState.qualification_stage) ?? readString(conversationState.conversation_stage),
      collected: Object.keys(asRecord(taskState.collected)).length > 0 ? asRecord(taskState.collected) : asRecord(conversationState.collected),
      last_bot_question: readString(taskState.last_bot_question) ?? readString(conversationState.last_bot_question),
      last_bot_action: readString(taskState.last_bot_action) ?? readString(conversationState.last_bot_action),
      pending_slots: readStringArray(taskState.pending_slots).length > 0 ? readStringArray(taskState.pending_slots) : readStringArray(conversationState.pending_slots),
    },
    booking_context: {
      has_active_hold: typeof bookingContext.has_active_hold === "boolean" ? bookingContext.has_active_hold : false,
      active_hold: asRecordOrNull(bookingContext.active_hold),
      latest_appointment: asRecordOrNull(bookingContext.latest_appointment),
    },
    case_context: {
      has_current_case: typeof caseContext.has_current_case === "boolean" ? caseContext.has_current_case : false,
      current_case: asRecordOrNull(caseContext.current_case),
      open_cases_count: typeof caseContext.open_cases_count === "number" ? caseContext.open_cases_count : 0,
    },
  };
}

export function createOpenAIRuntimeGateClassifier(deps: { client: OpenAIResponsesClient; model: string }): RuntimeGateClassifier {
  return {
    async classifyRuntimeGateTurn(input: RuntimeGateClassifierInput): Promise<unknown> {
      const response = await deps.client.responses.create({
        model: deps.model,
        instructions: RUNTIME_GATE_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }],
      });
      return parseClassifierOutput(response);
    },
  };
}

function parseClassifierOutput(raw: unknown): unknown {
  const obj = asRecord(raw);
  const outputText = readString(obj.output_text);
  if (outputText) return parseClassifierJson(outputText);
  const output = obj.output;
  if (!Array.isArray(output)) throw new Error("missing_runtime_gate_classifier_output");
  for (const item of output) {
    const itemObj = asRecord(item);
    if (readString(itemObj.type) !== "message") continue;
    const content = itemObj.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const partObj = asRecord(part);
      if (readString(partObj.type) !== "output_text") continue;
      const text = readString(partObj.text);
      if (text) return parseClassifierJson(text);
    }
  }
  throw new Error("missing_runtime_gate_classifier_output");
}

export function parseRuntimeGateClassifierJson(text: string): unknown {
  return parseClassifierJson(text);
}

function parseClassifierJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = extractJsonCandidate(trimmed);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("invalid_runtime_gate_classifier_json");
  }
}

function extractJsonCandidate(text: string): string {
  const startFence = "```";
  const firstFence = text.indexOf(startFence);
  if (firstFence === -1) return text;
  const secondFence = text.indexOf(startFence, firstFence + startFence.length);
  if (secondFence === -1) return text;
  const fencedBody = text.slice(firstFence + startFence.length, secondFence).trim();
  return fencedBody.startsWith("json") ? fencedBody.slice(4).trim() : fencedBody;
}

function truncateDebugOutput(rawOutput: string): string {
  if (rawOutput.length <= MAX_DEBUG_OUTPUT_CHARS) return rawOutput;
  return `${rawOutput.slice(0, MAX_DEBUG_OUTPUT_CHARS)}...[truncated ${rawOutput.length - MAX_DEBUG_OUTPUT_CHARS} chars]`;
}

function extractRuntimeGateValue(raw: unknown): Record<string, unknown> {
  const value = asRecord(raw);
  const envelopeValue = asRecord(value.runtime_gate);
  if (Object.keys(envelopeValue).length > 0) return envelopeValue;
  const rawOutput = readString(value.classifier_raw_output);
  if (rawOutput) {
    try {
      const parsed = parseClassifierJson(truncateDebugOutput(rawOutput));
      return asRecord(parsed);
    } catch {
      return value;
    }
  }
  return value;
}

function isValidRuntimeGateClassifierValue(raw: Record<string, unknown>): boolean {
  return ROUTES.includes(raw.route as RuntimeGateRoute)
    && TURN_SHAPES.includes(raw.turn_shape as RuntimeGateTurnShape)
    && CONFIDENCES.includes(raw.confidence as RuntimeGateConfidence)
    && typeof raw.reason === "string"
    && raw.reason.trim().length > 0
    && raw.should_apply === false;
}

function pickOne<T extends string>(allowed: readonly T[], raw: unknown, fallback: T): T {
  return allowed.some((item) => item === raw) ? raw as T : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

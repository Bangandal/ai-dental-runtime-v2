import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { RuntimeGateDebug } from "./runtimeGateShadow.ts";

// Turn Understanding is a shadow-only operational contour step.
// It is observability only and must not mutate state, call tools, write memory,
// apply booking/case changes, route live traffic, or change patient-facing replies.

export type TurnUnderstandingTurnType =
  | "booking_request"
  | "availability_request"
  | "slot_fill"
  | "reschedule"
  | "cancel"
  | "urgent"
  | "admin_request"
  | "follow_up"
  | "process_status_inquiry"
  | "postpone"
  | "confirmation_response"
  | "mixed"
  | "unknown";
export type TurnUnderstandingSubjectKind = "self" | "child" | "family_member" | "other" | "unknown";
export type TurnUnderstandingReplyObjective =
  | "answer"
  | "ask_missing_field"
  | "offer_next_step"
  | "explain_status"
  | "handoff"
  | "clarify"
  | "safe_fallback";
export type TurnUnderstandingCaseAction = "none" | "continue_existing" | "open_new" | "update_existing" | "close" | "handoff";
export type TurnUnderstandingCaseKind = "booking" | "reschedule" | "cancel" | "urgent" | "admin" | "follow_up" | "process_status" | "unknown" | null;
export type TurnUnderstandingConfidence = "low" | "medium" | "high";

export interface TurnUnderstandingDecision {
  turn_type: TurnUnderstandingTurnType;
  topic: string | null;
  service_interest: string | null;
  subject: {
    kind: TurnUnderstandingSubjectKind;
    display_name: string | null;
  };
  reply_objective: TurnUnderstandingReplyObjective;
  case_decision: {
    action: TurnUnderstandingCaseAction;
    case_kind: TurnUnderstandingCaseKind;
    target_case_id: null;
  };
  slot_updates: {
    service_interest: string | null;
    preferred_date: string | null;
    preferred_time: string | null;
    first_name: string | null;
    last_name: string | null;
    offered_slot_id: string | null;
    confirmation_target: string | null;
  };
  missing_fields: string[];
  confidence: TurnUnderstandingConfidence;
  reason: string;
  should_apply: false;
}

export interface TurnUnderstandingDebug {
  enabled: true;
  mode: "shadow";
  skipped: boolean;
  skip_reason: string | null;
  decision: TurnUnderstandingDecision | null;
  error: string | null;
}

export interface TurnUnderstandingClassifierInput {
  user_message: string;
  runtime_gate: RuntimeGateDebug;
  runtime_context: Record<string, unknown>;
}

export interface TurnUnderstandingClassifier {
  classifyTurnUnderstanding(input: TurnUnderstandingClassifierInput): Promise<unknown>;
}

const TURN_TYPES: readonly TurnUnderstandingTurnType[] = ["booking_request", "availability_request", "slot_fill", "reschedule", "cancel", "urgent", "admin_request", "follow_up", "process_status_inquiry", "postpone", "confirmation_response", "mixed", "unknown"];
const SUBJECT_KINDS: readonly TurnUnderstandingSubjectKind[] = ["self", "child", "family_member", "other", "unknown"];
const REPLY_OBJECTIVES: readonly TurnUnderstandingReplyObjective[] = ["answer", "ask_missing_field", "offer_next_step", "explain_status", "handoff", "clarify", "safe_fallback"];
const CASE_ACTIONS: readonly TurnUnderstandingCaseAction[] = ["none", "continue_existing", "open_new", "update_existing", "close", "handoff"];
const CASE_KINDS: readonly TurnUnderstandingCaseKind[] = ["booking", "reschedule", "cancel", "urgent", "admin", "follow_up", "process_status", "unknown", null];
const CONFIDENCES: readonly TurnUnderstandingConfidence[] = ["low", "medium", "high"];
const MAX_DEBUG_OUTPUT_CHARS = 4_000;
const MESSENGER_MVP_MISSING_FIELDS = new Set(["service_interest", "preferred_date", "preferred_time", "first_name", "last_name"]);
const BOOKING_MVP_TURN_TYPES = new Set<TurnUnderstandingTurnType>(["booking_request", "availability_request", "slot_fill", "reschedule"]);

const TURN_UNDERSTANDING_INSTRUCTIONS = [
  "You are a shadow-only Turn Understanding classifier for a dental frontdesk runtime.",
  "Classify only. Do not answer the patient.",
  "This signal is observability only and is not authoritative.",
  "Do not route live behavior, call tools, book appointments, mutate cases, write topic memory, or mutate databases.",
  "Return JSON only. No markdown. No prose.",
  "Return exactly one object matching this schema:",
  "{",
  '  "turn_type": "booking_request" | "availability_request" | "slot_fill" | "reschedule" | "cancel" | "urgent" | "admin_request" | "follow_up" | "process_status_inquiry" | "postpone" | "confirmation_response" | "mixed" | "unknown",',
  '  "topic": string | null,',
  '  "service_interest": string | null,',
  '  "subject": { "kind": "self" | "child" | "family_member" | "other" | "unknown", "display_name": string | null },',
  '  "reply_objective": "answer" | "ask_missing_field" | "offer_next_step" | "explain_status" | "handoff" | "clarify" | "safe_fallback",',
  '  "case_decision": { "action": "none" | "continue_existing" | "open_new" | "update_existing" | "close" | "handoff", "case_kind": "booking" | "reschedule" | "cancel" | "urgent" | "admin" | "follow_up" | "process_status" | "unknown" | null, "target_case_id": null },',
  '  "slot_updates": { "service_interest": string | null, "preferred_date": string | null, "preferred_time": string | null, "first_name": string | null, "last_name": string | null, "offered_slot_id": string | null, "confirmation_target": string | null },',
  '  "missing_fields": string[],',
  '  "confidence": "low" | "medium" | "high",',
  '  "reason": string,',
  '  "should_apply": false',
  "}",
  "should_apply must always be false and case_decision.target_case_id must always be null.",
  "Messenger MVP contact rule: phone is not a required field for messenger channels; channel/chat_id is already the contact channel.",
  "Never include phone in missing_fields. For booking_request, availability_request, slot_fill, and reschedule, missing_fields may only include service_interest, preferred_date, preferred_time, first_name, and last_name.",
  "If the user voluntarily provides a phone number, do not mark it as required and do not add phone to missing_fields.",
  "Classification guidance:",
  '"могу записаться?" -> booking_request, ask_missing_field.',
  '"чистка зубов на 05.06" after booking prompt -> slot_fill with service_interest and preferred_date.',
  '"14.00 михаил огар" after booking prompt -> slot_fill with preferred_time, first_name, and last_name.',
  '"перенести запись" -> reschedule.',
  '"отменить запись" -> cancel.',
  '"что с моими брекетами/заказом?" -> process_status_inquiry.',
  '"позовите администратора" -> admin_request.',
  "Urgent pain, swelling, or bleeding -> urgent.",
  "Mixed booking plus FAQ -> mixed with case_decision open_new booking, but should_apply false.",
].join(" ");

export function buildFallbackTurnUnderstandingDecision(reason = "turn understanding fallback; classifier unavailable or failed"): TurnUnderstandingDecision {
  return {
    turn_type: "unknown",
    topic: null,
    service_interest: null,
    subject: { kind: "unknown", display_name: null },
    reply_objective: "safe_fallback",
    case_decision: { action: "none", case_kind: "unknown", target_case_id: null },
    slot_updates: {
      service_interest: null,
      preferred_date: null,
      preferred_time: null,
      first_name: null,
      last_name: null,
      offered_slot_id: null,
      confirmation_target: null,
    },
    missing_fields: [],
    confidence: "low",
    reason,
    should_apply: false,
  };
}

export async function runTurnUnderstandingShadow(input: {
  user_message: string;
  runtime_gate: RuntimeGateDebug;
  runtime_context: Record<string, unknown>;
  classifier?: TurnUnderstandingClassifier;
}): Promise<TurnUnderstandingDebug> {
  if (input.runtime_gate.route !== "operational_candidate") {
    return {
      enabled: true,
      mode: "shadow",
      skipped: true,
      skip_reason: "runtime_gate_non_operational",
      decision: null,
      error: null,
    };
  }

  if (!input.classifier) {
    return {
      enabled: true,
      mode: "shadow",
      skipped: false,
      skip_reason: null,
      decision: buildFallbackTurnUnderstandingDecision("turn understanding fallback; classifier not connected"),
      error: null,
    };
  }

  try {
    const result = await input.classifier.classifyTurnUnderstanding({
      user_message: input.user_message,
      runtime_gate: input.runtime_gate,
      runtime_context: input.runtime_context,
    });
    const decision = extractTurnUnderstandingDecision(result);
    if (!isValidTurnUnderstandingDecision(decision)) {
      return buildErrorDebug("classifier_invalid_output");
    }
    return {
      enabled: true,
      mode: "shadow",
      skipped: false,
      skip_reason: null,
      decision: normalizeTurnUnderstandingDecision(decision),
      error: null,
    };
  } catch (error) {
    return buildErrorDebug(error instanceof Error ? error.message : String(error));
  }
}

export function sanitizeTurnUnderstandingContext(input: {
  user_message: string;
  runtime_gate: RuntimeGateDebug;
  runtime_context: unknown;
}): TurnUnderstandingClassifierInput {
  const root = asRecord(input.runtime_context);
  const taskState = asRecord(root.task_state);
  const conversationState = asRecord(root.conversation_state);
  const bookingContext = asRecord(root.booking_context);
  const caseContext = asRecord(root.case_context);
  const lastBotQuestion = readString(taskState.last_bot_question) ?? readString(conversationState.last_bot_question);
  const pendingSlots = readStringArray(taskState.pending_slots).length > 0 ? readStringArray(taskState.pending_slots) : readStringArray(conversationState.pending_slots);
  const latestAppointment = asRecordOrNull(bookingContext.latest_appointment);

  return {
    user_message: input.user_message,
    runtime_gate: input.runtime_gate,
    runtime_context: {
      user_message: input.user_message,
      runtime_gate: input.runtime_gate,
      task_state: {
        missing_fields: readStringArray(taskState.missing_fields).length > 0 ? readStringArray(taskState.missing_fields) : readStringArray(conversationState.missing_fields),
        last_known_intent: readString(taskState.last_known_intent) ?? readString(conversationState.intent),
        intake_status: readString(taskState.intake_status) ?? readString(conversationState.qualification_stage) ?? readString(conversationState.conversation_stage),
        collected: sanitizeRecord(Object.keys(asRecord(taskState.collected)).length > 0 ? asRecord(taskState.collected) : asRecord(conversationState.collected)),
        last_bot_question: lastBotQuestion,
        pending_slots: pendingSlots,
      },
      booking_context: {
        has_active_hold: typeof bookingContext.has_active_hold === "boolean" ? bookingContext.has_active_hold : false,
        active_hold: sanitizeRecordOrNull(bookingContext.active_hold),
        latest_appointment: sanitizeRecordOrNull(latestAppointment),
      },
      case_context: {
        has_current_case: typeof caseContext.has_current_case === "boolean" ? caseContext.has_current_case : false,
        current_case: sanitizeRecordOrNull(caseContext.current_case),
        open_cases_count: typeof caseContext.open_cases_count === "number" ? caseContext.open_cases_count : 0,
        recent_cases: sanitizeRecords(caseContext.recent_cases),
      },
      last_bot_question: lastBotQuestion,
      pending_slots: pendingSlots,
      latest_appointment: sanitizeRecordOrNull(latestAppointment),
    },
  };
}

export function normalizeTurnUnderstandingDecision(raw: unknown): TurnUnderstandingDecision {
  const value = asRecord(raw);
  const fallback = buildFallbackTurnUnderstandingDecision();
  const subject = asRecord(value.subject);
  const caseDecision = asRecord(value.case_decision);
  const slotUpdates = asRecord(value.slot_updates);
  return {
    turn_type: pickOne(TURN_TYPES, value.turn_type, fallback.turn_type),
    topic: readString(value.topic),
    service_interest: readString(value.service_interest),
    subject: {
      kind: pickOne(SUBJECT_KINDS, subject.kind, fallback.subject.kind),
      display_name: readString(subject.display_name),
    },
    reply_objective: pickOne(REPLY_OBJECTIVES, value.reply_objective, fallback.reply_objective),
    case_decision: {
      action: pickOne(CASE_ACTIONS, caseDecision.action, fallback.case_decision.action),
      case_kind: pickOne(CASE_KINDS, caseDecision.case_kind, fallback.case_decision.case_kind),
      target_case_id: null,
    },
    slot_updates: {
      service_interest: readString(slotUpdates.service_interest),
      preferred_date: readString(slotUpdates.preferred_date),
      preferred_time: readString(slotUpdates.preferred_time),
      first_name: readString(slotUpdates.first_name),
      last_name: readString(slotUpdates.last_name),
      offered_slot_id: readString(slotUpdates.offered_slot_id),
      confirmation_target: readString(slotUpdates.confirmation_target),
    },
    missing_fields: normalizeMissingFields(readStringArray(value.missing_fields), pickOne(TURN_TYPES, value.turn_type, fallback.turn_type)),
    confidence: pickOne(CONFIDENCES, value.confidence, fallback.confidence),
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : fallback.reason,
    should_apply: false,
  };
}

export function createOpenAITurnUnderstandingClassifier(deps: { client: OpenAIResponsesClient; model: string }): TurnUnderstandingClassifier {
  return {
    async classifyTurnUnderstanding(input: TurnUnderstandingClassifierInput): Promise<unknown> {
      const response = await deps.client.responses.create({
        model: deps.model,
        instructions: TURN_UNDERSTANDING_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }],
      });
      return parseClassifierOutput(response);
    },
  };
}

function buildErrorDebug(error: string): TurnUnderstandingDebug {
  return {
    enabled: true,
    mode: "shadow",
    skipped: false,
    skip_reason: null,
    decision: buildFallbackTurnUnderstandingDecision("turn understanding fallback; invalid classifier output"),
    error,
  };
}

function parseClassifierOutput(raw: unknown): unknown {
  const obj = asRecord(raw);
  const outputText = readString(obj.output_text);
  if (outputText) return parseClassifierJson(outputText);
  const output = obj.output;
  if (!Array.isArray(output)) throw new Error("missing_turn_understanding_classifier_output");
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
  throw new Error("missing_turn_understanding_classifier_output");
}

export function parseTurnUnderstandingClassifierJson(text: string): unknown {
  return parseClassifierJson(text);
}

function parseClassifierJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = extractJsonCandidate(trimmed);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("invalid_turn_understanding_classifier_json");
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

function extractTurnUnderstandingDecision(raw: unknown): unknown {
  const value = asRecord(raw);
  const envelopeDecision = value.decision;
  if (Object.keys(asRecord(envelopeDecision)).length > 0) return envelopeDecision;
  const envelope = asRecord(value.turn_understanding);
  if (Object.keys(envelope).length > 0 && Object.keys(asRecord(envelope.decision)).length > 0) return envelope.decision;
  return raw;
}

function isValidTurnUnderstandingDecision(raw: unknown): boolean {
  const value = asRecord(raw);
  const subject = asRecord(value.subject);
  const caseDecision = asRecord(value.case_decision);
  const slotUpdates = asRecord(value.slot_updates);
  return TURN_TYPES.includes(value.turn_type as TurnUnderstandingTurnType)
    && SUBJECT_KINDS.includes(subject.kind as TurnUnderstandingSubjectKind)
    && REPLY_OBJECTIVES.includes(value.reply_objective as TurnUnderstandingReplyObjective)
    && CASE_ACTIONS.includes(caseDecision.action as TurnUnderstandingCaseAction)
    && CASE_KINDS.includes(caseDecision.case_kind as TurnUnderstandingCaseKind)
    && caseDecision.target_case_id === null
    && Object.keys(slotUpdates).length > 0
    && Array.isArray(value.missing_fields)
    && value.missing_fields.every((item) => typeof item === "string")
    && CONFIDENCES.includes(value.confidence as TurnUnderstandingConfidence)
    && typeof value.reason === "string"
    && value.reason.trim().length > 0
    && value.should_apply === false;
}

function normalizeMissingFields(fields: string[], turnType: TurnUnderstandingTurnType): string[] {
  const normalized: string[] = [];
  for (const field of fields) {
    // Phone collection is intentionally disabled for current messenger MVP.
    // Future callback/clinic-config phone collection must be added explicitly, not as a default slot.
    if (field === "phone") continue;
    if (BOOKING_MVP_TURN_TYPES.has(turnType) && !MESSENGER_MVP_MISSING_FIELDS.has(field)) continue;
    if (!normalized.includes(field)) normalized.push(field);
  }
  return normalized;
}

function sanitizeRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(sanitizeRecord).filter((record) => Object.keys(record).length > 0) : [];
}

function sanitizeRecordOrNull(value: unknown): Record<string, unknown> | null {
  const record = sanitizeRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key.endsWith("_id") || key === "id" || key === "case_id" || key === "contact_id" || key === "clinic_id" || key === "chat_id" || key === "external_user_id") continue;
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) {
      sanitized[key] = typeof entry === "string" ? truncateDebugOutput(entry) : entry;
    } else if (Array.isArray(entry)) {
      sanitized[key] = entry.filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null).slice(0, 20);
    } else if (entry && typeof entry === "object") {
      const nested = sanitizeRecord(entry);
      if (Object.keys(nested).length > 0) sanitized[key] = nested;
    }
  }
  return sanitized;
}

function truncateDebugOutput(rawOutput: string): string {
  if (rawOutput.length <= MAX_DEBUG_OUTPUT_CHARS) return rawOutput;
  return `${rawOutput.slice(0, MAX_DEBUG_OUTPUT_CHARS)}...[truncated ${rawOutput.length - MAX_DEBUG_OUTPUT_CHARS} chars]`;
}

function pickOne<T extends string | null>(allowed: readonly T[], raw: unknown, fallback: T): T {
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

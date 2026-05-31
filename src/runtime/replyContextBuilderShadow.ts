import type { RuntimeGateDebug } from "./runtimeGateShadow.ts";
import type { TurnUnderstandingDebug, TurnUnderstandingDecision } from "./turnUnderstandingShadow.ts";

// Reply Context Builder is a shadow-only operational contour step.
// It is observability only and must not mutate state, call tools, write memory,
// apply booking/case changes, route live traffic, or change patient-facing replies.

export type ReplyContextWhatToDo =
  | "answer_question"
  | "ask_missing_fields"
  | "offer_availability"
  | "clarify"
  | "acknowledge_postpone"
  | "handle_reschedule"
  | "handoff"
  | "safe_fallback";

export interface ReplyContext {
  what_to_do: ReplyContextWhatToDo;
  what_is_known: {
    service_interest: string | null;
    preferred_date: string | null;
    preferred_time: string | null;
    first_name: string | null;
    last_name: string | null;
    subject_kind: string | null;
    turn_type: string | null;
  };
  what_is_missing: string[];
  do_not_ask: string[];
  do_not_promise: string[];
  do_not_confirm: string[];
  safety_constraints: string[];
  safe_reply_frame: string;
}

export interface ReplyContextBuilderDebug {
  enabled: true;
  mode: "shadow";
  skipped: boolean;
  skip_reason: string | null;
  context: ReplyContext | null;
  error: string | null;
}

export interface BuildReplyContextShadowInput {
  runtime_gate: RuntimeGateDebug;
  turn_understanding: TurnUnderstandingDebug;
}

const BASE_DO_NOT_PROMISE = [
  "appointment_confirmed",
  "specific_doctor",
  "specific_slot_available",
  "clinical_outcome",
] as const;

const BASE_SAFETY_CONSTRAINTS = [
  "no_booking_confirmation_without_backend_proof",
  "no_medical_diagnosis",
  "messenger_phone_not_required",
] as const;

export function buildReplyContextShadow(input: BuildReplyContextShadowInput): ReplyContextBuilderDebug {
  const turnUnderstanding = input.turn_understanding;
  if (turnUnderstanding.skipped) {
    return skippedReplyContext("turn_understanding_skipped");
  }

  if (!turnUnderstanding.decision) {
    return skippedReplyContext("turn_understanding_missing_decision");
  }

  const decision = turnUnderstanding.decision;
  const known = buildKnownFields(decision);
  const missingFields = uniqueStrings(decision.missing_fields);
  const whatToDo = mapWhatToDo(decision, missingFields);

  return {
    enabled: true,
    mode: "shadow",
    skipped: false,
    skip_reason: null,
    context: {
      what_to_do: whatToDo,
      what_is_known: known,
      what_is_missing: missingFields,
      do_not_ask: buildDoNotAsk(known),
      do_not_promise: [...BASE_DO_NOT_PROMISE],
      do_not_confirm: ["booking"],
      safety_constraints: [...BASE_SAFETY_CONSTRAINTS],
      safe_reply_frame: buildSafeReplyFrame(whatToDo),
    },
    error: null,
  };
}

function skippedReplyContext(skipReason: string): ReplyContextBuilderDebug {
  return {
    enabled: true,
    mode: "shadow",
    skipped: true,
    skip_reason: skipReason,
    context: null,
    error: null,
  };
}

function buildKnownFields(decision: TurnUnderstandingDecision): ReplyContext["what_is_known"] {
  const slotUpdates = decision.slot_updates;
  return {
    service_interest: readString(slotUpdates.service_interest) ?? readString(decision.service_interest),
    preferred_date: readString(slotUpdates.preferred_date),
    preferred_time: readString(slotUpdates.preferred_time),
    first_name: readString(slotUpdates.first_name),
    last_name: readString(slotUpdates.last_name),
    subject_kind: readString(decision.subject.kind),
    turn_type: readString(decision.turn_type),
  };
}

function buildDoNotAsk(known: ReplyContext["what_is_known"]): string[] {
  const doNotAsk = ["phone"];
  if (known.service_interest) doNotAsk.push("service_interest");
  if (known.preferred_date) doNotAsk.push("preferred_date");
  if (known.preferred_time) doNotAsk.push("preferred_time");
  return doNotAsk;
}

function mapWhatToDo(decision: TurnUnderstandingDecision, missingFields: string[]): ReplyContextWhatToDo {
  switch (decision.turn_type) {
    case "booking_request":
    case "slot_fill":
      return missingFields.length > 0 ? "ask_missing_fields" : "offer_availability";
    case "availability_request":
      return "offer_availability";
    case "reschedule":
      return "handle_reschedule";
    case "cancel":
    case "urgent":
    case "admin_request":
    case "process_status_inquiry":
      return "handoff";
    case "postpone":
      return "acknowledge_postpone";
    case "mixed":
      return decision.case_decision.case_kind === "booking" && missingFields.length > 0
        ? "ask_missing_fields"
        : "answer_question";
    case "follow_up":
    case "confirmation_response":
      return "answer_question";
    case "unknown":
      return decision.confidence === "low" ? "safe_fallback" : "clarify";
  }
}

function buildSafeReplyFrame(whatToDo: ReplyContextWhatToDo): string {
  switch (whatToDo) {
    case "ask_missing_fields":
      return "Ask only for missing fields. Do not ask for phone.";
    case "offer_availability":
      return "Offer the next availability step without confirming a booking or specific slot.";
    case "handle_reschedule":
      return "Acknowledge the reschedule request and collect needed details without confirming changes.";
    case "handoff":
      return "Acknowledge request and hand off to human/admin. Do not promise status.";
    case "acknowledge_postpone":
      return "Acknowledge the postponement and avoid asking for new booking fields unless the patient resumes.";
    case "answer_question":
      return "Answer the question and ask the next missing booking field if appropriate.";
    case "clarify":
      return "Ask a brief clarifying question before taking any operational step.";
    case "safe_fallback":
      return "Use a safe fallback and avoid promises, confirmations, diagnosis, or operational changes.";
  }
}

function uniqueStrings(values: string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length > 0 && !unique.includes(normalized)) unique.push(normalized);
  }
  return unique;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

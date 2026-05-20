import type { BookingAction, PlannerOutput, ReplyStrategy, TurnType } from "./toolPolicy.ts";

export interface PlannerParseResult {
  ok: boolean;
  planner: PlannerOutput;
  errors: string[];
  warnings: string[];
}

const SAFE_REPLY_STRATEGY: ReplyStrategy = "ask_clarification";

const SAFE_FALLBACK: PlannerOutput = {
  turn_type: "unknown",
  confidence: "low",
  tools_requested: [],
  reply_strategy: SAFE_REPLY_STRATEGY,
  booking_action: null,
  explicit_patient_confirmation: false,
  booking_request: {
    service: null,
    preferred_date_text: null,
    preferred_time_text: null,
  },
};

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_REPLY_STRATEGY = new Set<ReplyStrategy>([
  "answer_only",
  "ask_clarification",
  "answer_then_offer_slots",
  "offer_slot_then_wait_confirmation",
  "confirm_booking",
  "safe_fallback",
]);
const VALID_BOOKING_ACTION = new Set<BookingAction>([
  "check_availability",
  "create_hold",
  "confirm",
  "cancel_hold",
  "reschedule_check",
  "reschedule_confirm",
  "cancel_request",
  null,
]);
const VALID_TURN_TYPE = new Set<TurnType>([
  "faq",
  "booking",
  "availability_request",
  "reschedule",
  "cancel",
  "greeting",
  "off_topic",
  "unknown",
]);

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function normalizeStringOrNull(value: unknown, field: string, warnings: string[]): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  warnings.push(`${field} must be string|null; coercing to null`);
  return null;
}

export function parsePlannerOutput(raw: unknown): PlannerParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const parsed: PlannerOutput = {
    ...SAFE_FALLBACK,
    booking_request: { ...SAFE_FALLBACK.booking_request },
  };

  const rawObject = asRecord(raw);
  if (!rawObject) {
    errors.push("planner output must be an object");
    return { ok: false, planner: parsed, errors, warnings };
  }

  const rawConfidence = rawObject.confidence;
  const rawTurnType = rawObject.turn_type;
  if (VALID_TURN_TYPE.has(rawTurnType as TurnType)) {
    parsed.turn_type = rawTurnType as TurnType;
  } else if (rawTurnType !== undefined) {
    warnings.push("invalid turn_type; defaulting to unknown");
  }

  if (VALID_CONFIDENCE.has(rawConfidence as "high" | "medium" | "low")) {
    parsed.confidence = rawConfidence as "high" | "medium" | "low";
  } else if (rawConfidence !== undefined) {
    warnings.push("invalid confidence; defaulting to low");
  }

  const rawTools = rawObject.tools_requested;
  if (Array.isArray(rawTools)) {
    parsed.tools_requested = rawTools.flatMap((tool) => {
      if (typeof tool === "string") {
        return [tool];
      }
      warnings.push("non-string tool name ignored");
      return [];
    });
  } else if (rawTools !== undefined) {
    warnings.push("tools_requested must be an array; defaulting to empty list");
  }

  const rawReplyStrategy = rawObject.reply_strategy;
  if (VALID_REPLY_STRATEGY.has(rawReplyStrategy as ReplyStrategy)) {
    parsed.reply_strategy = rawReplyStrategy as ReplyStrategy;
  } else if (rawReplyStrategy !== undefined) {
    warnings.push("invalid reply_strategy; defaulting to ask_clarification");
  }

  const rawBookingAction = rawObject.booking_action;
  if (VALID_BOOKING_ACTION.has(rawBookingAction as BookingAction)) {
    parsed.booking_action = rawBookingAction as BookingAction;
  } else if (rawBookingAction !== undefined) {
    warnings.push("invalid booking_action; defaulting to null");
  }

  if (typeof rawObject.explicit_patient_confirmation === "boolean") {
    parsed.explicit_patient_confirmation = rawObject.explicit_patient_confirmation;
  } else if (rawObject.explicit_patient_confirmation !== undefined) {
    warnings.push("explicit_patient_confirmation must be boolean; defaulting to false");
  }

  const rawBookingRequest = asRecord(rawObject.booking_request);
  if (rawObject.booking_request === undefined || rawObject.booking_request === null) {
    // use safe fallback
  } else if (rawBookingRequest) {
    parsed.booking_request = {
      service: normalizeStringOrNull(rawBookingRequest.service, "booking_request.service", warnings),
      preferred_date_text: normalizeStringOrNull(
        rawBookingRequest.preferred_date_text,
        "booking_request.preferred_date_text",
        warnings,
      ),
      preferred_time_text: normalizeStringOrNull(
        rawBookingRequest.preferred_time_text,
        "booking_request.preferred_time_text",
        warnings,
      ),
    };
  } else {
    warnings.push("booking_request must be an object; defaulting to null-safe object");
  }

  const ok = errors.length === 0;
  return { ok, planner: parsed, errors, warnings };
}

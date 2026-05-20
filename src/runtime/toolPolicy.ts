export type Confidence = "high" | "medium" | "low";

export type ToolName =
  | "kb.search"
  | "availability.check"
  | "hold.create"
  | "booking.confirm"
  | "cancel_hold"
  | "appointment.mutate"
  | "admin.notify";

export type ReplyStrategy =
  | "answer_only"
  | "ask_clarification"
  | "answer_then_offer_slots"
  | "offer_slot_then_wait_confirmation"
  | "confirm_booking"
  | "safe_fallback";

export type BookingAction =
  | "check_availability"
  | "create_hold"
  | "confirm"
  | "cancel_hold"
  | null;

export interface PlannerOutput {
  confidence: Confidence;
  tools_requested: ToolName[];
  reply_strategy: ReplyStrategy;
  booking_action: BookingAction;
  explicit_patient_confirmation?: boolean;
  booking_request?: {
    service?: string | null;
    preferred_date_text?: string | null;
    preferred_time_text?: string | null;
  };
}

export interface TruthSnapshot {
  active_hold_exists: boolean;
  hold_not_expired: boolean;
  contact_case_match: boolean;
  contradiction_in_turn?: boolean;
}

export type PolicyDenyReason =
  | "low_confidence_execution_gate"
  | "booking_confirm_requires_high_confidence"
  | "booking_confirm_requires_active_hold"
  | "booking_confirm_requires_explicit_confirmation"
  | "booking_confirm_requires_unexpired_hold"
  | "booking_confirm_contact_case_mismatch"
  | "insufficient_booking_request_data"
  | "contradiction_in_turn";

export interface ToolDecision {
  tool: ToolName;
  allowed: boolean;
  reason?: PolicyDenyReason;
}

export interface PolicyResult {
  tools_allowed: ToolName[];
  tools_denied: ToolDecision[];
  reply_strategy: ReplyStrategy;
  booking_action: BookingAction;
  admin_notify_suppressed: boolean;
}

const WRITE_TOOLS = new Set<ToolName>([
  "hold.create",
  "booking.confirm",
  "cancel_hold",
  "appointment.mutate",
  "admin.notify",
]);

export function applyToolPolicy(
  planner: PlannerOutput,
  truth: TruthSnapshot,
): PolicyResult {
  const denied: ToolDecision[] = [];
  const allowed: ToolName[] = [];

  const isLowConfidence = planner.confidence === "low";
  let replyStrategy = planner.reply_strategy;
  let bookingAction = planner.booking_action;

  if (isLowConfidence) {
    if (replyStrategy !== "safe_fallback" && replyStrategy !== "ask_clarification") {
      replyStrategy = "ask_clarification";
    }
    bookingAction = null;
  }

  for (const tool of planner.tools_requested) {
    if (isLowConfidence && WRITE_TOOLS.has(tool)) {
      denied.push({ tool, allowed: false, reason: "low_confidence_execution_gate" });
      continue;
    }

    if (tool === "hold.create") {
      if (planner.confidence === "low") {
        denied.push({ tool, allowed: false, reason: "low_confidence_execution_gate" });
        continue;
      }
      if (!hasEnoughBookingRequestData(planner.booking_request)) {
        denied.push({ tool, allowed: false, reason: "insufficient_booking_request_data" });
        continue;
      }
      if (truth.contradiction_in_turn) {
        denied.push({ tool, allowed: false, reason: "contradiction_in_turn" });
        continue;
      }
      allowed.push(tool);
      continue;
    }

    if (tool === "booking.confirm") {
      if (planner.confidence !== "high") {
        denied.push({ tool, allowed: false, reason: "booking_confirm_requires_high_confidence" });
        continue;
      }
      if (!truth.active_hold_exists) {
        denied.push({ tool, allowed: false, reason: "booking_confirm_requires_active_hold" });
        continue;
      }
      if (!planner.explicit_patient_confirmation) {
        denied.push({ tool, allowed: false, reason: "booking_confirm_requires_explicit_confirmation" });
        continue;
      }
      if (!truth.hold_not_expired) {
        denied.push({ tool, allowed: false, reason: "booking_confirm_requires_unexpired_hold" });
        continue;
      }
      if (!truth.contact_case_match) {
        denied.push({ tool, allowed: false, reason: "booking_confirm_contact_case_mismatch" });
        continue;
      }
      allowed.push(tool);
      continue;
    }

    allowed.push(tool);
  }

  return {
    tools_allowed: allowed,
    tools_denied: denied,
    reply_strategy: replyStrategy,
    booking_action: bookingAction,
    admin_notify_suppressed: isLowConfidence,
  };
}

function hasEnoughBookingRequestData(request: PlannerOutput["booking_request"]): boolean {
  if (!request?.service) return false;
  return Boolean(request.preferred_date_text && request.preferred_time_text);
}

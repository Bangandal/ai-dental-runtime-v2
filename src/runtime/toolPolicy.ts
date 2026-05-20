export type Confidence = "high" | "medium" | "low";

export type ToolName =
  | "kb.search"
  | "availability.check"
  | "hold.create"
  | "booking.confirm"
  | "cancel_hold"
  | "appointment.mutate";

export type RawToolName = string;

export type ToolClass = "read" | "write" | "destructive";

export type SideEffectType = "admin.notify";

export type RuntimeSideEffect = {
  type: SideEffectType;
  eligible: boolean;
  reason?: "low_confidence_execution_gate";
};

export type BackendEventType = "booking.confirm.success" | "faq.soft_interest";

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
  tools_requested: RawToolName[];
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
  availability_result_exists?: boolean;
  proposed_slot_exists?: boolean;
  service_known?: boolean;
  explicit_slot_rejection?: boolean;
  explicit_cancellation_request?: boolean;
  scheduling_intent_present?: boolean;
  date_or_time_present?: boolean;
}

export type PolicyDenyReason =
  | "low_confidence_execution_gate"
  | "booking_confirm_requires_high_confidence"
  | "booking_confirm_requires_active_hold"
  | "booking_confirm_requires_explicit_confirmation"
  | "booking_confirm_requires_unexpired_hold"
  | "booking_confirm_contact_case_mismatch"
  | "insufficient_booking_request_data"
  | "contradiction_in_turn"
  | "invalid_tool_requested"
  | "availability_check_requires_confidence"
  | "scheduling_intent_missing"
  | "date_or_time_missing"
  | "availability_result_required"
  | "proposed_slot_required"
  | "service_required"
  | "cancel_hold_requires_active_hold"
  | "cancel_hold_requires_explicit_rejection_or_cancellation"
  | "appointment_mutation_not_implemented";

export interface ToolDecision {
  tool: RawToolName;
  allowed: boolean;
  reason?: PolicyDenyReason;
}

export interface PolicyResult {
  tools_allowed: ToolName[];
  tools_denied: ToolDecision[];
  reply_strategy: ReplyStrategy;
  booking_action: BookingAction;
  side_effects: RuntimeSideEffect[];
}

export const TOOL_POLICY_MATRIX: Record<ToolName, { class: ToolClass }> = {
  "kb.search": { class: "read" },
  "availability.check": { class: "read" },
  "hold.create": { class: "write" },
  "booking.confirm": { class: "write" },
  "cancel_hold": { class: "destructive" },
  "appointment.mutate": { class: "destructive" },
};

const RUNTIME_TOOLS = new Set<ToolName>(Object.keys(TOOL_POLICY_MATRIX) as ToolName[]);

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

  for (const rawTool of planner.tools_requested) {
    if (!RUNTIME_TOOLS.has(rawTool as ToolName)) {
      denied.push({ tool: rawTool, allowed: false, reason: "invalid_tool_requested" });
      continue;
    }

    const tool = rawTool as ToolName;
    const toolClass = TOOL_POLICY_MATRIX[tool].class;

    if (isLowConfidence && toolClass !== "read") {
      denied.push({ tool, allowed: false, reason: "low_confidence_execution_gate" });
      continue;
    }

    if (tool === "kb.search") {
      allowed.push(tool);
      continue;
    }

    if (tool === "availability.check") {
      if (planner.confidence === "low") {
        denied.push({ tool, allowed: false, reason: "availability_check_requires_confidence" });
        continue;
      }
      if (truth.contradiction_in_turn) {
        denied.push({ tool, allowed: false, reason: "contradiction_in_turn" });
        continue;
      }
      if (!truth.scheduling_intent_present) {
        denied.push({ tool, allowed: false, reason: "scheduling_intent_missing" });
        continue;
      }
      if (!truth.date_or_time_present) {
        denied.push({ tool, allowed: false, reason: "date_or_time_missing" });
        continue;
      }
      allowed.push(tool);
      continue;
    }

    if (tool === "hold.create") {
      if (truth.contradiction_in_turn) {
        denied.push({ tool, allowed: false, reason: "contradiction_in_turn" });
        continue;
      }
      if (!truth.availability_result_exists) {
        denied.push({ tool, allowed: false, reason: "availability_result_required" });
        continue;
      }
      if (!truth.proposed_slot_exists) {
        denied.push({ tool, allowed: false, reason: "proposed_slot_required" });
        continue;
      }
      if (!truth.service_known) {
        denied.push({ tool, allowed: false, reason: "service_required" });
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

    if (tool === "cancel_hold") {
      if (!truth.active_hold_exists) {
        denied.push({ tool, allowed: false, reason: "cancel_hold_requires_active_hold" });
        continue;
      }
      const hasExplicitCancellationSignal = Boolean(
        truth.explicit_slot_rejection || truth.explicit_cancellation_request,
      );
      if (!hasExplicitCancellationSignal) {
        denied.push({ tool, allowed: false, reason: "cancel_hold_requires_explicit_rejection_or_cancellation" });
        continue;
      }
      allowed.push(tool);
      continue;
    }

    denied.push({ tool, allowed: false, reason: "appointment_mutation_not_implemented" });
  }

  return {
    tools_allowed: allowed,
    tools_denied: denied,
    reply_strategy: replyStrategy,
    booking_action: bookingAction,
    side_effects: [],
  };
}

export function deriveRuntimeSideEffects(
  confidence: Confidence,
  backendEvents: BackendEventType[],
): RuntimeSideEffect[] {
  if (backendEvents.includes("booking.confirm.success")) {
    if (confidence === "low") {
      return [{ type: "admin.notify", eligible: false, reason: "low_confidence_execution_gate" }];
    }
    return [{ type: "admin.notify", eligible: true }];
  }

  return [];
}

import type { RuntimeAgentToolRequest } from "./openaiRuntimeAgent.ts";
import type { AvailableSlot } from "./bookingProcessState.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "./slotEvidence.ts";
import {
  evaluateBookingApplyPreflightPolicy,
  type BookingApplyPreflightGuardCode,
} from "./bookingApplyPreflightPolicy.ts";
import type {
  BookingApplyGuardedData,
  BookingApplyPastTimeDetail,
} from "./bookingApplyPreflightPolicy.ts";

export type {
  BookingApplyGuardedData,
  BookingApplyPastTimeDetail,
} from "./bookingApplyPreflightPolicy.ts";

export type BookingApplyPreflightDecision =
  | { outcome: "allow" }
  | {
      outcome: "block";
      debug_reason: string;
      guarded_data: BookingApplyGuardedData;
      missing_fields?: string[];
      past_time_detail?: BookingApplyPastTimeDetail;
    };

/**
 * Historical loop-facing contract. `round` remains here only to preserve existing
 * diagnostic strings while runtimeAgentLoopLegacy still has explicit model-call phases.
 * The underlying business policy and booking legality are round-agnostic.
 */
export interface EvaluateBookingApplyPreflightParams {
  round: 1 | 2;
  pendingBookingApply: RuntimeAgentToolRequest;
  pendingToolRequests: RuntimeAgentToolRequest[];
  pendingTypedPhone: boolean;
  hasBookingPhone: boolean;
  activeAvailabilityEvidence: AvailabilityEvidence | null | undefined;
  selectedSlot?: AvailableSlot | null;
  selectedSlotProof?: SelectedSlotProof | null;
  timezone: string;
  now: Date;
}

function legacyDebugReason(round: 1 | 2, code: BookingApplyPreflightGuardCode): string {
  if (code === "missing_trusted_phone" && round === 2) {
    return "booking_apply_intercepted_missing_trusted_phone";
  }
  return `booking_apply_preflight_${code}_round${round}`;
}

/**
 * Compatibility adapter for the historical runtime loop.
 *
 * Business guard ordering and outcomes are owned by `evaluateBookingApplyPreflightPolicy`.
 * This adapter contributes only the old round-shaped debug reason strings; it cannot weaken
 * selected-slot evidence requirements based on model-call phase.
 */
export function evaluateBookingApplyPreflight(
  params: EvaluateBookingApplyPreflightParams,
): BookingApplyPreflightDecision {
  const decision = evaluateBookingApplyPreflightPolicy({
    pendingBookingApply: params.pendingBookingApply,
    pendingToolRequests: params.pendingToolRequests,
    pendingTypedPhone: params.pendingTypedPhone,
    hasBookingPhone: params.hasBookingPhone,
    activeAvailabilityEvidence: params.activeAvailabilityEvidence,
    selectedSlot: params.selectedSlot,
    selectedSlotProof: params.selectedSlotProof,
    timezone: params.timezone,
    now: params.now,
  });

  if (decision.outcome === "allow") return decision;

  return {
    outcome: "block",
    debug_reason: legacyDebugReason(params.round, decision.guard_code),
    guarded_data: decision.guarded_data,
    ...(decision.missing_fields !== undefined ? { missing_fields: decision.missing_fields } : {}),
    ...(decision.past_time_detail !== undefined ? { past_time_detail: decision.past_time_detail } : {}),
  };
}

import { buildLegacyBookingApplyDebugReason } from "./bookingApplyPreflightDecision.ts";
import type { RuntimeTurnToolBatchResult } from "./runtimeTurnToolBatch.ts";

/**
 * Temporary diagnostic adapter while runtimeAgentLoopLegacy still exposes historical
 * round-shaped debug.reason strings. It does not influence tool execution or legality.
 */
export function getLegacyRuntimeTurnToolBatchDebugReason(
  result: RuntimeTurnToolBatchResult,
  phase: 1 | 2,
): string | null {
  switch (result.decision) {
    case "no_booking_apply":
      return null;
    case "select_apply_conflict":
      return "booking_apply_preflight_select_slot_same_round";
    case "multiple_booking_apply":
      return phase === 1
        ? "booking_apply_preflight_multiple_booking_apply_round1"
        : "booking_apply_preflight_multiple_booking_apply_round2_multi";
    case "write_already_attempted":
      return phase === 1
        ? "booking_apply_preflight_multiple_booking_apply_round1"
        : "booking_apply_preflight_multiple_booking_apply_round2";
    case "subject_validation_failed":
      return `booking_apply_preflight_subject_id_invalid_round${phase}`;
    case "subject_resolution_failed":
      return `booking_apply_preflight_subject_resolution_conflict_round${phase}`;
    case "no_available_slots":
      return "booking_apply_preflight_no_slots";
    case "booking_preflight_blocked":
      return result.booking_preflight_guard_code
        ? buildLegacyBookingApplyDebugReason(phase, result.booking_preflight_guard_code)
        : null;
    case "booking_executed":
      return phase === 2 ? "booking_apply_executed_after_round2_request" : null;
  }
}

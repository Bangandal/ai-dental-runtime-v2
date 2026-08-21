import type { RuntimeAgentToolRequest } from "./openaiRuntimeAgent.ts";
import type { AvailableSlot } from "./bookingProcessState.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "./slotEvidence.ts";
import {
  bookingApplyArgsMissingService,
  bookingApplyArgsMissingSlot,
  getMissingBookingApplyNameFields,
  shouldInterceptInvalidSlotDateTime,
  shouldInterceptMissingSlotProof,
} from "./bookingApplyPreflight.ts";
import { getTodayInTimezone, isPastBookingTime } from "./bookingPreflight.ts";

export interface BookingApplyGuardedData {
  booking_status: string;
  created_visit: false;
  may_claim_booked: false;
  required_next_action: string;
  reason: string;
  missing_fields?: string[];
}

export interface BookingApplyPastTimeDetail {
  requestedDate: string | undefined;
  requestedTime: string | undefined;
  timezone: string;
  nowISO: string;
  todayInTimezone: string;
}

export type BookingApplyPreflightDecision =
  | { outcome: "allow" }
  | {
      outcome: "block";
      debug_reason: string;
      guarded_data: BookingApplyGuardedData;
      missing_fields?: string[];
      past_time_detail?: BookingApplyPastTimeDetail;
    };

export interface EvaluateBookingApplyPreflightParams {
  round: 1 | 2;
  pendingBookingApply: RuntimeAgentToolRequest;
  pendingToolRequests: RuntimeAgentToolRequest[];
  pendingTypedPhone: boolean;
  hasBookingPhone: boolean;
  activeAvailabilityEvidence: AvailabilityEvidence | null | undefined;
  selectedSlot?: AvailableSlot | null;
  selectedSlotProof?: SelectedSlotProof | null;
  includeInvalidSlotGuard: boolean;
  timezone: string;
  now: Date;
}

function debugReason(round: 1 | 2, code: string): string {
  if (code === "missing_trusted_phone" && round === 2) {
    return "booking_apply_intercepted_missing_trusted_phone";
  }
  return `booking_apply_preflight_${code}_round${round}`;
}

/**
 * Deterministic business preflight after the execution patient has been frozen.
 *
 * This owns the guard priority shared by both model-call rounds. Subject resolution,
 * same-round select/apply handling, no-slots handling, policy execution, and external
 * booking writes deliberately remain outside this boundary.
 */
export function evaluateBookingApplyPreflight(
  params: EvaluateBookingApplyPreflightParams,
): BookingApplyPreflightDecision {
  const { pendingBookingApply, pendingToolRequests } = params;

  if (params.pendingTypedPhone) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "pending_typed_phone"),
      guarded_data: {
        booking_status: "pending_phone_classification",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "none",
        reason: "typed_phone_subject_unclear",
      },
    };
  }

  const requestedDate = typeof pendingBookingApply.arguments.requested_date === "string"
    ? pendingBookingApply.arguments.requested_date
    : undefined;
  const requestedTime = typeof pendingBookingApply.arguments.requested_time === "string"
    ? pendingBookingApply.arguments.requested_time
    : undefined;

  if (isPastBookingTime({
    requestedDate,
    requestedTime,
    timezone: params.timezone,
    now: params.now,
  })) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "past_time"),
      guarded_data: {
        booking_status: "past_time",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "ask_for_alternative_time",
        reason: "requested_time_is_in_past",
      },
      past_time_detail: {
        requestedDate,
        requestedTime,
        timezone: params.timezone,
        nowISO: params.now.toISOString(),
        todayInTimezone: getTodayInTimezone(params.now, params.timezone),
      },
    };
  }

  if (bookingApplyArgsMissingSlot(pendingBookingApply.arguments)) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "missing_slot"),
      guarded_data: {
        booking_status: "missing_slot",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "ask_for_slot",
        reason: "requested_date_time_required",
      },
    };
  }

  const slotEvidenceParams = {
    pendingToolRequests,
    activeAvailabilityEvidence: params.activeAvailabilityEvidence,
    selectedSlot: params.selectedSlot,
    selectedSlotProof: params.selectedSlotProof,
  };

  if (shouldInterceptMissingSlotProof(slotEvidenceParams)) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "missing_slot_proof"),
      guarded_data: {
        booking_status: "slot_not_verified",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "ask_for_slot",
        reason: "slot_proof_required",
      },
    };
  }

  if (params.includeInvalidSlotGuard && shouldInterceptInvalidSlotDateTime(slotEvidenceParams)) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "invalid_slot"),
      guarded_data: {
        booking_status: "invalid_slot",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "choose_from_available_slots",
        reason: "requested_time_not_in_available_slots",
      },
    };
  }

  if (!params.hasBookingPhone) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "missing_trusted_phone"),
      guarded_data: {
        booking_status: "missing_trusted_phone",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "ask_for_phone",
        reason: "trusted_phone_required",
      },
    };
  }

  const missingNames = getMissingBookingApplyNameFields(pendingBookingApply.arguments);
  if (missingNames.length > 0) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "missing_name"),
      guarded_data: {
        booking_status: "missing_patient_name",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "ask_for_name",
        reason: "patient_name_required",
        missing_fields: missingNames,
      },
      missing_fields: missingNames,
    };
  }

  if (bookingApplyArgsMissingService(pendingBookingApply.arguments)) {
    return {
      outcome: "block",
      debug_reason: debugReason(params.round, "missing_service"),
      guarded_data: {
        booking_status: "missing_service",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "ask_for_service",
        reason: "service_required",
      },
    };
  }

  return { outcome: "allow" };
}

import type { AvailabilityEvidence } from "./slotEvidence.ts";
import { normalizeBookingRequestKey } from "./slotEvidence.ts";

export type BookingSelectSlotFailureReason =
  | "missing_slot"
  | "invalid_slot_format"
  | "no_active_availability_evidence"
  | "slot_not_in_active_evidence"
  | "subject_resolution_conflict";

export interface BookingSelectSlotSuccessData {
  selection_status: "selected";
  selected_slot_key: string;
  may_apply_booking: true;
}

export type BookingSelectSlotResult =
  | { ok: true; data: BookingSelectSlotSuccessData }
  | { ok: false; reason: BookingSelectSlotFailureReason };

const VALID_SUBJECT_IDS = new Set(["subject_1", "subject_2", "subject_3", "subject_4"]);

/**
 * Pure validator for booking.select_slot tool requests.
 *
 * Does NOT call ClinicCard. Does NOT create or update a visit.
 * Returns a deterministic success or failure result.
 *
 * Success means: the requested date+time is in the active availability evidence
 * and the runtime will persist a selected_slot_proof for this slot.
 */
export function executeBookingSelectSlot(
  args: Record<string, unknown>,
  activeEvidence: AvailabilityEvidence | null | undefined,
): BookingSelectSlotResult {
  // 1. Validate subject_id
  const subjectId = typeof args.subject_id === "string" ? args.subject_id.trim() : null;
  if (!subjectId || !VALID_SUBJECT_IDS.has(subjectId)) {
    return { ok: false, reason: "subject_resolution_conflict" };
  }

  // 2. Require date and time fields
  const date = typeof args.requested_date === "string" ? args.requested_date.trim() : null;
  const time = typeof args.requested_time === "string" ? args.requested_time.trim() : null;
  if (!date || !time) {
    return { ok: false, reason: "missing_slot" };
  }

  // 3. Require strict YYYY-MM-DD date and HH:MM time
  const slotKey = normalizeBookingRequestKey(date, time);
  if (!slotKey) {
    return { ok: false, reason: "invalid_slot_format" };
  }

  // 4. Require active availability evidence
  if (!activeEvidence) {
    return { ok: false, reason: "no_active_availability_evidence" };
  }

  // 5-6. Require the exact key to be in allowed_slot_keys
  if (!activeEvidence.allowed_slot_keys.includes(slotKey)) {
    return { ok: false, reason: "slot_not_in_active_evidence" };
  }

  return {
    ok: true,
    data: {
      selection_status: "selected",
      selected_slot_key: slotKey,
      may_apply_booking: true,
    },
  };
}

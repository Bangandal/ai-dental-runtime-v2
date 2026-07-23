import type { AvailabilityEvidence } from "./slotEvidence.ts";
import { normalizeBookingRequestKey } from "./slotEvidence.ts";
import { parseSubjectId, type SubjectId } from "./bookingSubjectsState.ts";

export type BookingSelectSlotFailureReason =
  | "missing_slot"
  | "invalid_slot_format"
  | "no_active_availability_evidence"
  | "slot_not_in_active_evidence"
  | "subject_resolution_conflict"
  | "ambiguous_selection";

export interface BookingSelectSlotSuccessData {
  selection_status: "selected";
  subject_id: SubjectId;
  selected_slot_key: string;
  may_apply_booking: true;
}

export type BookingSelectSlotResult =
  | { ok: true; data: BookingSelectSlotSuccessData }
  | { ok: false; reason: BookingSelectSlotFailureReason };

/**
 * Pure validator for booking.select_slot tool requests.
 *
 * Does NOT call ClinicCard. Does NOT create or update a visit.
 * Returns a deterministic success or failure result.
 *
 * Success means: the requested date+time is in the active availability evidence
 * and the runtime will persist a selected_slot_proof for this slot.
 *
 * subjects: resolved registry from current turn. null = no registry (simple self-booking,
 * only subject_1 allowed). An empty array means the registry exists but has no subjects.
 */
export function executeBookingSelectSlot(
  args: Record<string, unknown>,
  activeEvidence: AvailabilityEvidence | null | undefined,
  subjects?: Array<{ id: SubjectId }> | null,
): BookingSelectSlotResult {
  // 1. Parse subject_id using the shared subject parser
  const subjectId = parseSubjectId(args.subject_id);
  if (!subjectId) {
    return { ok: false, reason: "subject_resolution_conflict" };
  }

  // 2. Resolve subject against registry when present; allow only subject_1 without one
  if (subjects !== null && subjects !== undefined) {
    if (!subjects.some((s) => s.id === subjectId)) {
      return { ok: false, reason: "subject_resolution_conflict" };
    }
  } else {
    if (subjectId !== "subject_1") {
      return { ok: false, reason: "subject_resolution_conflict" };
    }
  }

  // 3. Require date and time fields
  const date = typeof args.requested_date === "string" ? args.requested_date.trim() : null;
  const time = typeof args.requested_time === "string" ? args.requested_time.trim() : null;
  if (!date || !time) {
    return { ok: false, reason: "missing_slot" };
  }

  // 4. Require strict YYYY-MM-DD date and HH:MM time
  const slotKey = normalizeBookingRequestKey(date, time);
  if (!slotKey) {
    return { ok: false, reason: "invalid_slot_format" };
  }

  // 5. Require active availability evidence
  if (!activeEvidence) {
    return { ok: false, reason: "no_active_availability_evidence" };
  }

  // 6. Require the exact key to be in allowed_slot_keys
  if (!activeEvidence.allowed_slot_keys.includes(slotKey)) {
    return { ok: false, reason: "slot_not_in_active_evidence" };
  }

  return {
    ok: true,
    data: {
      selection_status: "selected",
      subject_id: subjectId,
      selected_slot_key: slotKey,
      may_apply_booking: true,
    },
  };
}

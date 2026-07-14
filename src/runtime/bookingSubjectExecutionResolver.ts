import type { BookingSubjectsState, SubjectId } from "./bookingSubjectsState.ts";

// ── subject execution resolution ──────────────────────────────────────────────

/** Typed reason codes for subject_resolution_conflict results. */
export type SubjectResolutionConflictReason =
  | "subject_id_required"       // registry active but model omitted subject_id
  | "invalid_subject_id_format" // subject_id present but not a valid subject_N id
  | "subject_not_in_registry"   // subject_id valid format but not found in current state
  | "subject_already_booked"    // target subject is already booked — no re-booking allowed
  | "registry_completed"        // entire registry is completed — no new booking.apply
  | "subject_state_invalid";    // subject exists but has an invalid internal state

export type SubjectExecutionResolution =
  | { ok: true; execution_subject_id: SubjectId }
  | { ok: false; booking_status: "subject_resolution_conflict"; reason: SubjectResolutionConflictReason };

const SUBJECT_ID_RE = /^subject_\d+$/;
// Only subject_1..subject_4 are valid booking targets
const VALID_SUBJECT_IDS = new Set<string>(["subject_1", "subject_2", "subject_3", "subject_4"]);

/**
 * Resolve which subject a pending booking.apply request targets.
 *
 * Called when booking_subjects registry is active (state != null).
 * When no registry exists (single-subject flow), this function is NOT called.
 *
 * Rules:
 * - Completed registry → registry_completed conflict (no new bookings).
 * - subject_id absent or null → subject_id_required conflict (no active-subject fallback).
 * - subject_id present but bad format → invalid_subject_id_format conflict.
 * - subject_id valid but not in registry → subject_not_in_registry conflict.
 * - target already booked → subject_already_booked conflict.
 * - Otherwise → ok with frozen execution_subject_id.
 */
export function resolveBookingExecutionSubject(
  state: BookingSubjectsState,
  bookingApplyArgs: Record<string, unknown>,
): SubjectExecutionResolution {
  // Completed registry: block all new booking.apply immediately.
  if (state.status === "completed") {
    return { ok: false, booking_status: "subject_resolution_conflict", reason: "registry_completed" };
  }

  // Active registry: subject_id is mandatory. No fallback to active_subject_id.
  const rawSubjectId = bookingApplyArgs.subject_id;
  if (rawSubjectId == null) {
    return { ok: false, booking_status: "subject_resolution_conflict", reason: "subject_id_required" };
  }

  if (typeof rawSubjectId !== "string" || !SUBJECT_ID_RE.test(rawSubjectId) || !VALID_SUBJECT_IDS.has(rawSubjectId)) {
    return { ok: false, booking_status: "subject_resolution_conflict", reason: "invalid_subject_id_format" };
  }

  const subjectId = rawSubjectId as SubjectId;
  const subject = state.subjects.find((s) => s.id === subjectId);
  if (!subject) {
    return { ok: false, booking_status: "subject_resolution_conflict", reason: "subject_not_in_registry" };
  }

  if (subject.status === "booked") {
    return { ok: false, booking_status: "subject_resolution_conflict", reason: "subject_already_booked" };
  }

  return { ok: true, execution_subject_id: subjectId };
}

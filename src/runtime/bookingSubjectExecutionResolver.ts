import type { BookingSubjectsState, SubjectId } from "./bookingSubjectsState.ts";

// ── subject execution resolution ──────────────────────────────────────────────

/**
 * Result of resolving which subject a booking.apply call targets.
 * Called before tool execution to freeze the execution context.
 */
export type SubjectExecutionResolution =
  | { ok: true; execution_subject_id: SubjectId }
  | { ok: false; booking_status: "subject_resolution_conflict"; reason: string };

const SUBJECT_ID_RE = /^subject_\d+$/;

/**
 * Resolve which subject a pending booking.apply request targets.
 *
 * Priority:
 * 1. booking.apply.arguments.subject_id — explicit model-provided target
 * 2. state.active_subject_id — fallback when registry is active but no explicit id
 *
 * Returns conflict when subject_id is set but invalid or not found in state.
 * Called after model produces tool request, before guards and phone resolution.
 */
export function resolveBookingExecutionSubject(
  state: BookingSubjectsState,
  bookingApplyArgs: Record<string, unknown>,
): SubjectExecutionResolution {
  const rawSubjectId = bookingApplyArgs.subject_id;

  if (rawSubjectId == null) {
    // Model did not specify — fall back to current active subject
    return { ok: true, execution_subject_id: state.active_subject_id };
  }

  if (typeof rawSubjectId !== "string" || !SUBJECT_ID_RE.test(rawSubjectId)) {
    return {
      ok: false,
      booking_status: "subject_resolution_conflict",
      reason: "invalid_subject_id_format",
    };
  }

  const subjectId = rawSubjectId as SubjectId;
  const exists = state.subjects.some((s) => s.id === subjectId);
  if (!exists) {
    return {
      ok: false,
      booking_status: "subject_resolution_conflict",
      reason: "subject_not_in_registry",
    };
  }

  return { ok: true, execution_subject_id: subjectId };
}

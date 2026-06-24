/**
 * Logical Case contract types for Runtime V2.
 *
 * These types represent the logical contract defined in
 * docs/MINIMAL_CASE_STORE_CONTRACT.md. They are adapter-facing: all
 * CaseRepository methods accept and return these types. Physical DB fields
 * (case_type, collected/meta jsonb) are translated inside the repository
 * adapter and must not leak to callers.
 */

export type CaseKind =
  | "booking_intake"
  | "reschedule"
  | "cancel"
  | "admin_handoff"
  | "process_status"
  | "urgent";

export type SubjectKind = "self" | "friend" | "child" | "partner" | "other";

export type CaseStatus =
  | "collecting"
  | "ready_for_action"
  | "action_in_progress"
  | "handoff"
  | "closed"
  | "cancelled"
  | "expired";

export type CaseOutcome =
  | "booked"
  | "handed_off"
  | "cancelled_by_patient"
  | "unsupported_service"
  | "abandoned"
  | "answered"
  | "failed"
  | "duplicate"
  | "expired";

export interface Case {
  case_id: string;
  clinic_id: string;
  contact_id: string;
  conversation_id: string | null;
  case_kind: CaseKind;
  subject_kind: SubjectKind | null;
  subject_display_name: string | null;
  subject_relation: string | null;
  service_interest: string | null;
  preferred_date: string | null;
  preferred_time: string | null;
  urgency: boolean;
  handoff_reason: string | null;
  notes: string | null;
  status: CaseStatus | null;
  outcome: CaseOutcome | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

export interface FindActiveCaseInput {
  clinic_id: string;
  contact_id: string;
  conversation_id: string;
  case_kind: CaseKind;
  subject_kind: SubjectKind;
  subject_display_name?: string;
}

export interface OpenCaseInput {
  clinic_id: string;
  contact_id: string;
  conversation_id: string;
  case_kind: CaseKind;
  subject_kind: SubjectKind;
  subject_display_name?: string;
  subject_relation?: string;
  service_interest?: string;
  preferred_date?: string;
  preferred_time?: string;
  urgency?: boolean;
  notes?: string;
}

export type CaseEventActor = "patient_agent" | "runtime_core" | "operator";

export interface AppendCaseEventInput {
  case_id: string;
  clinic_id: string;
  event_kind: string;
  actor: CaseEventActor;
  payload?: Record<string, unknown>;
  trace_id?: string;
  message_id?: string;
}

/**
 * Maps physical case_type (stored in core.cases) to logical CaseKind.
 *
 * The physical field is set at case open time by the adapter. For new cases
 * created by this runtime the values will match 1:1. Legacy cases may carry
 * old values ("booking", "faq", etc.) which are mapped best-effort.
 *
 * Confirm the full mapping against the live DB before implementing write paths.
 */
export function physicalCaseTypeToKind(caseType: string | null | undefined): CaseKind {
  switch (caseType) {
    case "booking_intake":
    case "booking": // legacy alias
    case "intake":  // possible legacy alias
      return "booking_intake";
    case "reschedule":
      return "reschedule";
    case "cancel":
      return "cancel";
    case "admin_handoff":
      return "admin_handoff";
    case "process_status":
    case "post_booking": // legacy closest match
    case "faq":          // legacy closest match
      return "process_status";
    case "urgent":
      return "urgent";
    default:
      // Unknown physical values default to process_status (safest read fallback).
      // Log and do not throw — read path must not crash on legacy data.
      return "process_status";
  }
}

/**
 * Maps logical CaseKind to physical case_type for write operations.
 * Only used by write-path methods (openCase, mergeCaseState, closeCase).
 * Confirm against live DB before implementing write paths.
 */
export function caseKindToPhysicalType(kind: CaseKind): string {
  return kind; // new cases store the logical value directly
}

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

/**
 * Mutable fields on an active case. case_kind is immutable after open and must
 * not appear here. outcome and close fields are handled by closeCase only.
 */
export interface CaseStatePatch {
  subject_kind?: SubjectKind;
  subject_display_name?: string;
  subject_relation?: string;
  service_interest?: string;
  preferred_date?: string;
  preferred_time?: string;
  urgency?: boolean;
  handoff_reason?: string;
  notes?: string;
  status?: CaseStatus;
}

export interface MergeCaseStateInput {
  clinic_id: string;
  contact_id: string;
  conversation_id: string;
  case_id: string;
  patch: CaseStatePatch;
}

export interface AppendCaseEventInput {
  case_id: string;
  clinic_id: string;
  contact_id: string;
  event_kind: string;
  actor: CaseEventActor;
  payload?: Record<string, unknown>;
  trace_id?: string;
  message_id?: string;
  lead_id?: string;
  notification_id?: string;
}

/**
 * Maps physical case_type (stored in core.cases) to logical CaseKind.
 *
 * Covers both legacy values (booking, faq, post_booking) and the physical
 * values written by rpc_apply_case_decision_v1 (booking_request, admin_request,
 * follow_up, etc.). Unknown values fall back to process_status without throwing.
 */
export function physicalCaseTypeToKind(caseType: string | null | undefined): CaseKind {
  switch (caseType) {
    case "booking_intake":
    case "booking_request":     // physical value written by rpc_apply_case_decision_v1
    case "availability_request":// physical alias
    case "booking":             // legacy alias
    case "intake":              // legacy alias
      return "booking_intake";
    case "reschedule":
      return "reschedule";
    case "cancel":
      return "cancel";
    case "admin_handoff":
    case "admin_request":       // physical value written by rpc_apply_case_decision_v1
      return "admin_handoff";
    case "process_status":
    case "follow_up":           // physical value written by rpc_apply_case_decision_v1
    case "post_booking":        // legacy alias
    case "faq":                 // legacy alias
    case "other":               // physical fallback
      return "process_status";
    case "urgent":
      return "urgent";
    default:
      // Unknown physical values default to process_status — read path must not throw.
      return "process_status";
  }
}

/**
 * Maps logical CaseKind to the physical case_type accepted by rpc_apply_case_decision_v1.
 *
 * Physical values are drawn from the caseRouterShadow CaseType enum observed in
 * the live codebase: booking_request, admin_request, follow_up, urgent, reschedule, cancel.
 * Logical values like booking_intake, admin_handoff, process_status are NOT accepted
 * by the RPC and must not be passed directly.
 */
export function caseKindToPhysicalType(kind: CaseKind): string {
  switch (kind) {
    case "booking_intake": return "booking_request";
    case "reschedule":     return "reschedule";
    case "cancel":         return "cancel";
    case "admin_handoff":  return "admin_request";
    case "process_status": return "follow_up";
    case "urgent":         return "urgent";
  }
}

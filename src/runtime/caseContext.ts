export type PatientSubjectType =
  | "self"
  | "child"
  | "partner"
  | "sibling"
  | "family_member"
  | "other"
  | "unknown";

export interface PatientSubject {
  type: PatientSubjectType;
  display_name?: string | null;
  relation_text?: string | null;
}

export interface CaseContext {
  case_id?: string | null;
  contact_id?: string | null;
  patient_subject: PatientSubject;
  service_interest?: string | null;
  case_type?:
    | "faq"
    | "booking"
    | "reschedule"
    | "cancel"
    | "document"
    | "post_booking"
    | "unknown";
}

export type AuthorityLevel =
  | "system_can_answer"
  | "needs_business_truth"
  | "needs_human_authority";

export type AuthorityBoundaryReason =
  | "missing_business_truth"
  | "doctor_note_required"
  | "medical_decision_required"
  | "price_dispute"
  | "insurance_unclear"
  | "user_requested_human"
  | "high_risk_low_confidence";

export interface AuthorityDecision {
  level: AuthorityLevel;
  reasons: AuthorityBoundaryReason[];
}

export interface DeriveAuthorityDecisionInput {
  requested_doctor_conclusion?: boolean;
  has_doctor_note?: boolean;
  asks_medical_decision?: boolean;
  price_dispute?: boolean;
  insurance_exact_coverage_requested?: boolean;
  user_requested_human?: boolean;
  high_risk_low_confidence?: boolean;
}

export function buildDefaultPatientSubject(): PatientSubject {
  return {
    type: "unknown",
    display_name: null,
    relation_text: null,
  };
}

export function deriveAuthorityDecision(
  input: DeriveAuthorityDecisionInput,
): AuthorityDecision {
  const reasons = new Set<AuthorityBoundaryReason>();

  const requestedDoctorConclusion = Boolean(input.requested_doctor_conclusion);
  const hasDoctorNote = Boolean(input.has_doctor_note);

  if (requestedDoctorConclusion && !hasDoctorNote) {
    reasons.add("doctor_note_required");
  }

  if (Boolean(input.asks_medical_decision)) {
    reasons.add("medical_decision_required");
  }

  if (Boolean(input.price_dispute)) {
    reasons.add("price_dispute");
  }

  if (Boolean(input.insurance_exact_coverage_requested)) {
    reasons.add(hasDoctorNote ? "missing_business_truth" : "insurance_unclear");
  }

  if (Boolean(input.user_requested_human)) {
    reasons.add("user_requested_human");
  }

  if (Boolean(input.high_risk_low_confidence)) {
    reasons.add("high_risk_low_confidence");
  }

  const reasonList = Array.from(reasons);

  const needsHumanAuthority = reasonList.some((reason) =>
    reason === "doctor_note_required"
    || reason === "medical_decision_required"
    || reason === "price_dispute"
    || reason === "insurance_unclear"
    || reason === "user_requested_human"
    || reason === "high_risk_low_confidence"
  );

  if (needsHumanAuthority) {
    return {
      level: "needs_human_authority",
      reasons: reasonList,
    };
  }

  if (requestedDoctorConclusion && hasDoctorNote) {
    return {
      level: "needs_business_truth",
      reasons: ["missing_business_truth"],
    };
  }

  if (reasonList.includes("missing_business_truth")) {
    return {
      level: "needs_business_truth",
      reasons: reasonList,
    };
  }

  return {
    level: "system_can_answer",
    reasons: [],
  };
}

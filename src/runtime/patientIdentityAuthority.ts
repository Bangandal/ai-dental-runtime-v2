export type PatientContactRole = "patient" | "responsible_party";

export interface ResolvePatientIdentityInput {
  first_name: string;
  last_name: string;
  phone_number: string;
  contact_role: PatientContactRole;
}

export type PatientIdentityResolution =
  | {
      ok: true;
      resolution: "existing_patient";
      patient_id: number;
    }
  | {
      ok: true;
      resolution: "create_patient_required";
    }
  | {
      ok: false;
      failure: "identity_ambiguous" | "external_failure";
      reason: string;
    };

/**
 * Deterministic, read-only boundary for resolving the target patient used by a booking write.
 *
 * The caller provides business semantics only: whether the supplied phone belongs
 * to the target patient or to a responsible party. Provider-specific lookup stays
 * behind this authority, while all provider writes remain owned by booking write
 * orchestration.
 */
export interface PatientIdentityAuthority {
  resolve(input: ResolvePatientIdentityInput): Promise<PatientIdentityResolution>;
}

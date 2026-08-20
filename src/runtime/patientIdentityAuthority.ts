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
      patient_id: number;
      resolution: "existing_patient" | "created_patient";
    }
  | {
      ok: false;
      failure: "identity_ambiguous" | "external_failure";
      reason: string;
    };

/**
 * Deterministic boundary for resolving the target patient used by a booking write.
 *
 * The caller provides business semantics only: whether the supplied phone belongs
 * to the target patient or to a responsible party. Provider-specific lookup and
 * patient-record creation stay behind this authority.
 */
export interface PatientIdentityAuthority {
  resolveOrCreate(input: ResolvePatientIdentityInput): Promise<PatientIdentityResolution>;
}

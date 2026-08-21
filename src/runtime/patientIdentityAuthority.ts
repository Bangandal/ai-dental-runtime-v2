export interface ResolvePatientIdentityInput {
  first_name: string;
  last_name: string;
  phone_number: string;
  /**
   * Ownership fact only. No social role is needed by the clean kernel.
   * true means the lookup phone belongs to the target patient;
   * false means it belongs to another person and cannot independently prove identity.
   */
  phone_belongs_to_patient: boolean;
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
 * The caller supplies the target person's name plus an explicit ownership fact for the
 * lookup phone. The authority does not know about subjects, family relations, senders,
 * or responsible-party roles. Provider-specific lookup stays behind this boundary,
 * while all provider writes remain owned by booking write orchestration.
 */
export interface PatientIdentityAuthority {
  resolve(input: ResolvePatientIdentityInput): Promise<PatientIdentityResolution>;
}

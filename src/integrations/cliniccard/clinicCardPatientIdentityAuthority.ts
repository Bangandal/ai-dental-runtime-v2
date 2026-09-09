import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type {
  PatientIdentityAuthority,
  PatientIdentityResolution,
  ResolvePatientIdentityInput,
} from "../../runtime/patientIdentityAuthority.ts";

function normalizePatientName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function patientNameMatchesTarget(patientName: string, firstName: string, lastName: string): boolean {
  const candidate = normalizePatientName(patientName);
  const firstLast = normalizePatientName(`${firstName} ${lastName}`);
  const lastFirst = normalizePatientName(`${lastName} ${firstName}`);
  return candidate === firstLast || candidate === lastFirst;
}

function ambiguous(reason: string): PatientIdentityResolution {
  return { ok: false, failure: "identity_ambiguous", reason };
}

function externalFailure(reason: string): PatientIdentityResolution {
  return { ok: false, failure: "external_failure", reason };
}

export function createClinicCardPatientIdentityAuthority(adapter: ClinicCardAdapter): PatientIdentityAuthority {
  return {
    async resolve(input: ResolvePatientIdentityInput): Promise<PatientIdentityResolution> {
      const findResult = await adapter.findPatientByPhone(input.phone_number);
      if (!findResult.ok) {
        return externalFailure(`Patient lookup failed: ${findResult.error.message}`);
      }

      const phoneBelongsToPatient = input.phone_belongs_to_patient;

      // INV-ID-01: a phone asserted to belong to the target patient but shared by
      // multiple ClinicCard records is itself ambiguous. Never name-tiebreak it.
      if (phoneBelongsToPatient && findResult.data.length > 1) {
        return ambiguous(
          `Phone lookup returned ${findResult.data.length} patient records — shared phone is an identity conflict, admin handoff required`,
        );
      }

      const nameMatches = findResult.data.filter((patient) =>
        patientNameMatchesTarget(patient.name ?? "", input.first_name, input.last_name),
      );

      if (nameMatches.length === 1) {
        return {
          ok: true,
          patient_id: nameMatches[0].id,
          resolution: "existing_patient",
        };
      }

      if (nameMatches.length > 1) {
        return ambiguous(
          `Multiple patients match name "${input.first_name} ${input.last_name}" for this phone — admin handoff required`,
        );
      }

      // INV-ID-02: exactly one phone record with no name match — phone wins.
      // The patient's Telegram display name may differ from their legal ClinicCard name
      // (nickname, maiden name, short form). With only one record on file, the phone is
      // the strongest available identity signal, so we reuse the existing patient.
      if (phoneBelongsToPatient && findResult.data.length === 1) {
        return {
          ok: true,
          patient_id: findResult.data[0].id,
          resolution: "existing_patient",
        };
      }

      // No candidate at all — booking orchestration may create a new patient record.
      // This authority deliberately performs no ClinicCard writes.
      return {
        ok: true,
        resolution: "create_patient_required",
      };
    },
  };
}

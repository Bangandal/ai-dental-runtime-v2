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
    async resolveOrCreate(input: ResolvePatientIdentityInput): Promise<PatientIdentityResolution> {
      const findResult = await adapter.findPatientByPhone(input.phone_number);
      if (!findResult.ok) {
        return externalFailure(`Patient lookup failed: ${findResult.error.message}`);
      }

      const isBorrowedPhone = input.contact_role === "responsible_party";

      // INV-ID-01: a target-patient phone shared by multiple ClinicCard records is
      // itself ambiguous. Never name-tiebreak and never pick data[0].
      if (!isBorrowedPhone && findResult.data.length > 1) {
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

      if (!isBorrowedPhone && findResult.data.length > 0) {
        return ambiguous(
          `Phone lookup returned patient record(s), but none match "${input.first_name} ${input.last_name}" — admin handoff required`,
        );
      }

      // No candidate + target phone, or responsible-party phone with no target-name
      // match, creates a separate target patient exactly as the pre-R1 executor did.
      const patientResult = await adapter.createPatient({
        name: `${input.first_name} ${input.last_name}`,
        phone: input.phone_number,
      });
      if (!patientResult.ok) {
        return externalFailure(patientResult.error.message);
      }

      return {
        ok: true,
        patient_id: patientResult.data.id,
        resolution: "created_patient",
      };
    },
  };
}

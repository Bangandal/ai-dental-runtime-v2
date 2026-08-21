import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type {
  BookingWriteAuthority,
  BookingWriteInput,
  BookingWriteResolution,
} from "../../runtime/bookingWriteAuthority.ts";

export function createClinicCardBookingWriteAuthority(
  adapter: ClinicCardAdapter,
): BookingWriteAuthority {
  return {
    async write(input: BookingWriteInput): Promise<BookingWriteResolution> {
      let patientId: number;

      if (input.patient.kind === "existing_patient") {
        patientId = input.patient.patient_id;
      } else {
        const patientResult = await adapter.createPatient({
          name: input.patient.name,
          phone: input.patient.phone_number,
        });
        if (!patientResult.ok) {
          return {
            ok: false,
            failure: "patient_write_failed",
            reason: patientResult.error.message,
          };
        }
        patientId = patientResult.data.id;
      }

      const visitResult = await adapter.createVisit({
        patient_id: patientId,
        doctor_id: input.visit.doctor_id,
        cabinet_id: input.visit.cabinet_id,
        date: input.visit.date,
        time_start: input.visit.time_start,
        time_end: input.visit.time_end,
        status: input.visit.status,
        note: input.visit.note,
      });

      if (!visitResult.ok) {
        return {
          ok: false,
          failure: "visit_write_failed",
          reason: visitResult.error.message,
          patient_id: patientId,
        };
      }

      return {
        ok: true,
        patient_id: patientId,
        visit: visitResult.data,
      };
    },
  };
}

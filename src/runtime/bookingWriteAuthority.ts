export type BookingPatientWriteTarget =
  | {
      kind: "existing_patient";
      patient_id: number;
    }
  | {
      kind: "create_patient";
      name: string;
      phone_number: string;
    };

export interface BookingVisitWriteInput {
  doctor_id: number;
  cabinet_id: number;
  date: string;
  time_start: string;
  time_end: string;
  status: "PLANNED" | "CONFIRMED" | "VISITED";
  note?: string;
}

export interface BookingWriteInput {
  patient: BookingPatientWriteTarget;
  visit: BookingVisitWriteInput;
}

export type BookingWriteResolution =
  | {
      ok: true;
      patient_id: number;
      visit: {
        id: number;
        patient_id?: number | null;
        doctor_id: number;
        cabinet_id: number;
        date: string;
        time_start: string;
        time_end: string;
        status: string;
        note?: string | null;
      };
    }
  | {
      ok: false;
      failure: "patient_write_failed" | "visit_write_failed";
      reason: string;
      /** Present when patient creation succeeded but the visit write failed. */
      patient_id?: number;
    };

/**
 * Deterministic boundary that owns the external side effects required to create
 * one booking after identity and slot legality have already been resolved.
 *
 * It does not decide patient identity, availability, slot legality, or locking.
 * Those decisions must be complete before this authority is called.
 */
export interface BookingWriteAuthority {
  write(input: BookingWriteInput): Promise<BookingWriteResolution>;
}

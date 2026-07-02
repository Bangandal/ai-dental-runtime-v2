export type ClinicCardBookingMode = "disabled" | "shadow" | "live";
export type ClinicCardVisitStatus = "PLANNED" | "CONFIRMED" | "VISITED";

export interface ClinicCardConfig {
  api_base_url: string;
  api_token: string;
  default_doctor_id: string;
  default_cabinet_id: string;
  timezone: string;
  booking_mode: ClinicCardBookingMode;
}

export interface ClinicCardPatient {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  birth_date?: string | null;
  created_at?: string | null;
}

export interface ClinicCardVisit {
  id: number;
  patient_id?: number | null;
  doctor_id: number;
  cabinet_id: number;
  date: string;
  time_start: string;
  time_end: string;
  status: ClinicCardVisitStatus;
  note?: string | null;
}

export interface ClinicCardPayment {
  id: number;
  patient_id?: number | null;
  amount: number;
  date: string;
  description?: string | null;
}

export interface ClinicCardCreatePatientInput {
  name: string;
  phone?: string;
  email?: string;
}

export interface ClinicCardCreateVisitInput {
  patient_id: number;
  doctor_id: number;
  cabinet_id: number;
  date: string;
  time_start: string;
  time_end: string;
  status: ClinicCardVisitStatus;
  note?: string;
}

export type ClinicCardResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

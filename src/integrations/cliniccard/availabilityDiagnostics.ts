export interface VisitSample {
  visit_id?: number;
  date: string;
  time_start: string;
  time_end: string;
  doctor_id?: number;
  cabinet_id?: number;
  status?: string;
}

export interface AvailabilityDiagnostic {
  requested_date: string;
  date_to?: string;
  timezone: string;
  doctor_id: number | null;
  cabinet_id: number | null;
  working_hours_start: string;
  working_hours_end: string;
  slot_duration_minutes: number;
  raw_visits_count: number;
  relevant_visits_count: number;
  total_slots: number;
  blocked_slots_count: number;
  free_slots_count_before_filters: number;
  free_slots_count_after_requested_time_filter: number;
  free_slots_count_after_past_time_filter: number;
  limited_slots_count: number;
  relevant_visits_sample: VisitSample[];
}

export function isAvailabilityDebugEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== "undefined" ? process.env : {});
  return source["CLINICCARD_AVAILABILITY_DEBUG"] === "true";
}

/** Strip PII (patient_id, note) from a visit for safe diagnostic logging. */
export function toVisitSample(visit: {
  id?: number;
  patient_id?: number | null;
  doctor_id: number;
  cabinet_id: number;
  date: string;
  time_start: string;
  time_end: string;
  status: string;
  note?: string | null;
}): VisitSample {
  return {
    visit_id: visit.id,
    date: visit.date,
    time_start: visit.time_start,
    time_end: visit.time_end,
    doctor_id: visit.doctor_id,
    cabinet_id: visit.cabinet_id,
    status: visit.status,
  };
}

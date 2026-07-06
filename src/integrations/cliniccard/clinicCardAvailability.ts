import type { ClinicCardResult, ClinicCardVisit } from "./clinicCardTypes.ts";
import { toVisitSample, type AvailabilityDiagnostic } from "./availabilityDiagnostics.ts";

export interface AvailabilityAdapter {
  listVisits(from: string, to: string): Promise<ClinicCardResult<ClinicCardVisit[]>>;
}

export interface AvailabilityInput {
  date: string;
  date_to?: string;
  working_hours_start: string;
  working_hours_end: string;
  slot_duration_minutes: number;
  doctor_id: number;
  cabinet_id: number;
  timezone: string;
  /** When true, diagnostic counts and visit sample are collected and returned. */
  debug?: boolean;
}

export interface AvailabilitySlot {
  date: string;
  time_start: string;
  time_end: string;
}

export interface AvailabilityOutput {
  slots: AvailabilitySlot[];
  total_slots: number;
  free_slots_count: number;
  /** Present only when input.debug=true. Never contains patient PII. */
  diagnostic?: AvailabilityDiagnostic;
}

function timeToMinutes(time: string): number {
  const sep = time.indexOf(":");
  const h = parseInt(time.slice(0, sep), 10);
  const m = parseInt(time.slice(sep + 1), 10);
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  let cur = from;
  while (cur <= to) {
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

// All visit records block their time slot regardless of status.
// PLANNED, CONFIRMED, VISITED are known occupied statuses.
// Unknown statuses are also treated as occupied for safety.
function visitBlocksSlot(
  slotStartMin: number,
  slotEndMin: number,
  visitStartMin: number,
  visitEndMin: number,
): boolean {
  return slotStartMin < visitEndMin && slotEndMin > visitStartMin;
}

export async function checkClinicCardAvailability(
  input: AvailabilityInput,
  adapter: AvailabilityAdapter,
): Promise<ClinicCardResult<AvailabilityOutput>> {
  if (!Number.isFinite(input.slot_duration_minutes) || input.slot_duration_minutes <= 0) {
    return {
      ok: false,
      error: {
        code: "cliniccard_availability_error",
        message: "slot_duration_minutes must be a positive finite number",
      },
    };
  }

  const dateTo = input.date_to ?? input.date;
  const visitsResult = await adapter.listVisits(input.date, dateTo);

  if (!visitsResult.ok) {
    return {
      ok: false,
      error: {
        code: "cliniccard_availability_error",
        message: visitsResult.error.message,
      },
    };
  }

  const rawVisitsCount = visitsResult.data.length;

  // A slot is blocked if the same doctor is busy in any cabinet,
  // or the same cabinet is busy with any doctor.
  const relevantVisits = visitsResult.data.filter(
    (v) => v.doctor_id === input.doctor_id || v.cabinet_id === input.cabinet_id,
  );

  const dates = dateRange(input.date, dateTo);
  const workStart = timeToMinutes(input.working_hours_start);
  const workEnd = timeToMinutes(input.working_hours_end);
  const duration = input.slot_duration_minutes;

  const slots: AvailabilitySlot[] = [];
  let total_slots = 0;
  let blocked_slots_count = 0;

  for (const date of dates) {
    const dayVisits = relevantVisits.filter((v) => v.date === date);

    for (let t = workStart; t + duration <= workEnd; t += duration) {
      total_slots++;
      const slotEnd = t + duration;

      const isFree = dayVisits.every((v) => {
        const visitStart = timeToMinutes(v.time_start);
        const visitEnd = timeToMinutes(v.time_end);
        return !visitBlocksSlot(t, slotEnd, visitStart, visitEnd);
      });

      if (isFree) {
        slots.push({
          date,
          time_start: minutesToTime(t),
          time_end: minutesToTime(slotEnd),
        });
      } else {
        blocked_slots_count++;
      }
    }
  }

  const diagnostic: AvailabilityDiagnostic | undefined = input.debug
    ? {
        requested_date: input.date,
        date_to: input.date_to,
        timezone: input.timezone,
        doctor_id: input.doctor_id,
        cabinet_id: input.cabinet_id,
        working_hours_start: input.working_hours_start,
        working_hours_end: input.working_hours_end,
        slot_duration_minutes: input.slot_duration_minutes,
        raw_visits_count: rawVisitsCount,
        relevant_visits_count: relevantVisits.length,
        total_slots,
        blocked_slots_count,
        free_slots_count_before_filters: slots.length,
        // post-filter counts filled in by the executor layer
        free_slots_count_after_requested_time_filter: slots.length,
        free_slots_count_after_past_time_filter: slots.length,
        limited_slots_count: slots.length,
        relevant_visits_sample: relevantVisits.slice(0, 5).map(toVisitSample),
      }
    : undefined;

  return {
    ok: true,
    data: {
      slots,
      total_slots,
      free_slots_count: slots.length,
      ...(diagnostic !== undefined ? { diagnostic } : {}),
    },
  };
}

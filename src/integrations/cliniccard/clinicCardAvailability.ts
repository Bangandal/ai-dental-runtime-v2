import type { ClinicCardResult, ClinicCardVisit } from "./clinicCardTypes.ts";

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
      }
    }
  }

  return {
    ok: true,
    data: {
      slots,
      total_slots,
      free_slots_count: slots.length,
    },
  };
}

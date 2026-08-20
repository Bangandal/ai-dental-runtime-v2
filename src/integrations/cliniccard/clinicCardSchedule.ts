import type { ClinicCardResult } from "./clinicCardTypes.ts";

export interface ClinicCardScheduleConfig {
  working_days: number[];
  working_hours_start: string;
  working_hours_end: string;
  slot_duration_minutes: number;
  holidays: string[];
}

export type ClinicCardScheduleConfigResult = ClinicCardResult<ClinicCardScheduleConfig>;

function missingField(name: string): ClinicCardScheduleConfigResult {
  return {
    ok: false,
    error: {
      code: "cliniccard_schedule_config_missing_field",
      message: `${name} is required but not set`,
    },
  };
}

function invalidField(name: string, reason: string): ClinicCardScheduleConfigResult {
  return {
    ok: false,
    error: {
      code: "cliniccard_schedule_config_invalid_field",
      message: `${name} ${reason}`,
    },
  };
}

function parseStrictHHMM(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseWorkingDays(raw: string): number[] | null {
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  const days: number[] = [];
  for (const token of tokens) {
    if (!/^[1-7]$/.test(token)) return null;
    const day = Number(token);
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
}

function parseHolidays(raw: string | undefined): string[] | null {
  if (!raw || raw.trim().length === 0) return [];
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.some((token) => !isValidDateOnly(token))) return null;
  return [...new Set(tokens)].sort();
}

export function loadClinicCardScheduleConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ClinicCardScheduleConfigResult {
  const workingDaysRaw = env["CLINICCARD_WORKING_DAYS"]?.trim();
  if (!workingDaysRaw) return missingField("CLINICCARD_WORKING_DAYS");
  const working_days = parseWorkingDays(workingDaysRaw);
  if (!working_days) {
    return invalidField("CLINICCARD_WORKING_DAYS", "must be a comma-separated list of ISO weekdays 1..7 (Monday=1)");
  }

  const working_hours_start = env["CLINICCARD_WORKING_HOURS_START"]?.trim();
  if (!working_hours_start) return missingField("CLINICCARD_WORKING_HOURS_START");
  const startMinutes = parseStrictHHMM(working_hours_start);
  if (startMinutes === null) {
    return invalidField("CLINICCARD_WORKING_HOURS_START", "must be strict HH:MM in 00:00..23:59");
  }

  const working_hours_end = env["CLINICCARD_WORKING_HOURS_END"]?.trim();
  if (!working_hours_end) return missingField("CLINICCARD_WORKING_HOURS_END");
  const endMinutes = parseStrictHHMM(working_hours_end);
  if (endMinutes === null) {
    return invalidField("CLINICCARD_WORKING_HOURS_END", "must be strict HH:MM in 00:00..23:59");
  }
  if (endMinutes <= startMinutes) {
    return invalidField("CLINICCARD_WORKING_HOURS_END", "must be later than CLINICCARD_WORKING_HOURS_START");
  }

  const durationRaw = env["CLINICCARD_SLOT_DURATION_MINUTES"]?.trim();
  if (!durationRaw) return missingField("CLINICCARD_SLOT_DURATION_MINUTES");
  if (!/^\d+$/.test(durationRaw)) {
    return invalidField("CLINICCARD_SLOT_DURATION_MINUTES", "must be a positive integer");
  }
  const slot_duration_minutes = Number(durationRaw);
  if (!Number.isSafeInteger(slot_duration_minutes) || slot_duration_minutes <= 0 || slot_duration_minutes > 480) {
    return invalidField("CLINICCARD_SLOT_DURATION_MINUTES", "must be an integer between 1 and 480");
  }
  if (slot_duration_minutes > endMinutes - startMinutes) {
    return invalidField("CLINICCARD_SLOT_DURATION_MINUTES", "must fit within the configured working-hours interval");
  }

  const holidays = parseHolidays(env["CLINICCARD_HOLIDAYS"]);
  if (holidays === null) {
    return invalidField("CLINICCARD_HOLIDAYS", "must be a comma-separated list of YYYY-MM-DD dates");
  }

  return {
    ok: true,
    data: {
      working_days,
      working_hours_start,
      working_hours_end,
      slot_duration_minutes,
      holidays,
    },
  };
}

export function isClinicWorkingDate(date: string, schedule: ClinicCardScheduleConfig): boolean {
  if (!isValidDateOnly(date)) return false;
  if (schedule.holidays.includes(date)) return false;
  const utcDay = new Date(`${date}T00:00:00Z`).getUTCDay();
  const isoWeekday = utcDay === 0 ? 7 : utcDay;
  return schedule.working_days.includes(isoWeekday);
}

export function isSlotWithinClinicSchedule(
  date: string,
  timeStart: string,
  durationMinutes: number,
  schedule: ClinicCardScheduleConfig,
): boolean {
  if (!isClinicWorkingDate(date, schedule)) return false;
  const slotStart = parseStrictHHMM(timeStart);
  const workStart = parseStrictHHMM(schedule.working_hours_start);
  const workEnd = parseStrictHHMM(schedule.working_hours_end);
  if (slotStart === null || workStart === null || workEnd === null) return false;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) return false;
  const slotEnd = slotStart + durationMinutes;
  return slotStart >= workStart && slotEnd <= workEnd;
}

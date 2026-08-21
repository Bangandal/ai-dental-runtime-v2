import type { ClinicCardResult } from "./clinicCardTypes.ts";

export interface ClinicCardAvailabilityPolicy {
  working_days: readonly number[];
  working_hours_start: string;
  working_hours_end: string;
  slot_duration_minutes: number;
  closed_dates: ReadonlySet<string>;
}

export type ClinicCardAvailabilityPolicyResult = ClinicCardResult<ClinicCardAvailabilityPolicy>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^(\d{2}):(\d{2})$/;

function parseStrictHHMM(value: string): string | null {
  const match = value.trim().match(HHMM_RE);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${match[1]}:${match[2]}`;
}

function isValidCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function missing(message: string): ClinicCardAvailabilityPolicyResult {
  return {
    ok: false,
    error: {
      code: "cliniccard_availability_policy_missing",
      message,
    },
  };
}

function invalid(message: string): ClinicCardAvailabilityPolicyResult {
  return {
    ok: false,
    error: {
      code: "cliniccard_availability_policy_invalid",
      message,
    },
  };
}

/**
 * Loads the operator-confirmed static schedule used when ClinicCard itself does
 * not provide a proven schedule/free-slots API.
 *
 * No working-day/hour/duration defaults are allowed here. Availability must fail
 * closed until the clinic explicitly confirms the policy.
 */
export function loadClinicCardAvailabilityPolicy(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ClinicCardAvailabilityPolicyResult {
  if (env["CLINICCARD_AVAILABILITY_POLICY_CONFIRMED"]?.trim().toLowerCase() !== "true") {
    return missing(
      "CLINICCARD_AVAILABILITY_POLICY_CONFIRMED=true is required before generated availability may be presented",
    );
  }

  const workingDaysRaw = env["CLINICCARD_WORKING_DAYS"]?.trim();
  if (!workingDaysRaw) {
    return missing("CLINICCARD_WORKING_DAYS is required, for example 1,2,3,4,5 for Monday-Friday");
  }

  const workingDays = workingDaysRaw.split(",").map((part) => Number(part.trim()));
  if (
    workingDays.length === 0
    || workingDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(workingDays).size !== workingDays.length
  ) {
    return invalid("CLINICCARD_WORKING_DAYS must contain unique ISO weekdays 1-7 separated by commas");
  }

  const workingHoursStartRaw = env["CLINICCARD_WORKING_HOURS_START"]?.trim();
  if (!workingHoursStartRaw) {
    return missing("CLINICCARD_WORKING_HOURS_START is required in strict HH:MM format");
  }
  const workingHoursStart = parseStrictHHMM(workingHoursStartRaw);
  if (!workingHoursStart) {
    return invalid("CLINICCARD_WORKING_HOURS_START must use strict HH:MM format");
  }

  const workingHoursEndRaw = env["CLINICCARD_WORKING_HOURS_END"]?.trim();
  if (!workingHoursEndRaw) {
    return missing("CLINICCARD_WORKING_HOURS_END is required in strict HH:MM format");
  }
  const workingHoursEnd = parseStrictHHMM(workingHoursEndRaw);
  if (!workingHoursEnd) {
    return invalid("CLINICCARD_WORKING_HOURS_END must use strict HH:MM format");
  }

  if (timeToMinutes(workingHoursEnd) <= timeToMinutes(workingHoursStart)) {
    return invalid("CLINICCARD_WORKING_HOURS_END must be later than CLINICCARD_WORKING_HOURS_START");
  }

  const durationRaw = env["CLINICCARD_SLOT_DURATION_MINUTES"]?.trim();
  if (!durationRaw) {
    return missing("CLINICCARD_SLOT_DURATION_MINUTES is required");
  }
  const slotDurationMinutes = Number(durationRaw);
  if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes <= 0) {
    return invalid("CLINICCARD_SLOT_DURATION_MINUTES must be a positive integer");
  }
  if (slotDurationMinutes > timeToMinutes(workingHoursEnd) - timeToMinutes(workingHoursStart)) {
    return invalid("CLINICCARD_SLOT_DURATION_MINUTES must fit inside the configured working interval");
  }

  if (!Object.prototype.hasOwnProperty.call(env, "CLINICCARD_CLOSED_DATES")) {
    return missing(
      "CLINICCARD_CLOSED_DATES must be explicitly set; use an empty value only when the clinic confirms there are no configured closure dates",
    );
  }

  const closedDatesRaw = env["CLINICCARD_CLOSED_DATES"]?.trim() ?? "";
  const closedDates = closedDatesRaw.length === 0
    ? []
    : closedDatesRaw.split(",").map((part) => part.trim());
  if (closedDates.some((date) => !isValidCalendarDate(date))) {
    return invalid("CLINICCARD_CLOSED_DATES must be a comma-separated list of valid YYYY-MM-DD dates");
  }

  return {
    ok: true,
    data: {
      working_days: workingDays,
      working_hours_start: workingHoursStart,
      working_hours_end: workingHoursEnd,
      slot_duration_minutes: slotDurationMinutes,
      closed_dates: new Set(closedDates),
    },
  };
}

/** ISO weekday, Monday=1 ... Sunday=7, for an already-normalized YYYY-MM-DD clinic date. */
export function getIsoWeekday(date: string): number | null {
  if (!isValidCalendarDate(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekday = parsed.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function isDateInsideAvailabilityPolicy(
  date: string,
  policy: ClinicCardAvailabilityPolicy,
): boolean {
  const weekday = getIsoWeekday(date);
  if (weekday === null) return false;
  return policy.working_days.includes(weekday) && !policy.closed_dates.has(date);
}

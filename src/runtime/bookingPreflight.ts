/**
 * Booking preflight safety guards.
 *
 * Past-time guard: prevents booking.apply execution and availability.check from
 * surfacing slots that have already passed in the clinic's local timezone.
 *
 * Used by runtimeAgentLoop (global preflight) and clinicCardAvailabilityExecutor
 * (slot filtering).
 */

export const BOOKING_LEAD_TIME_MINUTES = 0;

function timeToMinutes(hhmm: string): number {
  const sep = hhmm.indexOf(":");
  return parseInt(hhmm.slice(0, sep), 10) * 60 + parseInt(hhmm.slice(sep + 1), 10);
}

/** Returns the current time as "HH:MM" in the given IANA timezone. */
export function getNowHHMMInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

/** Returns today's date as "YYYY-MM-DD" in the given IANA timezone. */
export function getTodayInTimezone(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Returns true when slotTime (HH:MM) is at or before now + leadTimeMinutes
 * in the clinic timezone.  Use this to filter out slots the patient can no
 * longer book.
 */
export function isPastSlotTime(
  slotTimeHHMM: string,
  now: Date,
  timezone: string,
  leadTimeMinutes = BOOKING_LEAD_TIME_MINUTES,
): boolean {
  const nowHHMM = getNowHHMMInTimezone(now, timezone);
  const nowMinutes = timeToMinutes(nowHHMM) + leadTimeMinutes;
  const slotMinutes = timeToMinutes(slotTimeHHMM);
  return slotMinutes <= nowMinutes;
}

/**
 * Returns true when:
 *   - requestedDate is today (in clinic timezone), AND
 *   - requestedTime (HH:MM) is at or before now + leadTimeMinutes.
 *
 * If requestedTime is absent or un-parseable this is a conservative false
 * (let the executor handle any further validation).
 */
export function isPastBookingTime(params: {
  requestedDate: string | undefined | null;
  requestedTime: string | null | undefined;
  timezone: string;
  now: Date;
  leadTimeMinutes?: number;
}): boolean {
  const { requestedDate, requestedTime, timezone, now, leadTimeMinutes } = params;
  if (!requestedDate || !requestedTime) return false;
  const today = getTodayInTimezone(now, timezone);
  if (requestedDate !== today) return false;
  const parsed = requestedTime.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!parsed) return false;
  const h = Number(parsed[1]);
  const m = Number(parsed[2]);
  if (h > 23 || m > 59) return false;
  const slotHHMM = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return isPastSlotTime(slotHHMM, now, timezone, leadTimeMinutes);
}

const PAST_TIME_REPLIES: Record<string, string> = {
  ru: "Это время уже прошло. Пожалуйста, выберите другое время — я покажу свободные слоты.",
  cs: "Tento čas již uplynul. Prosím vyberte jiný čas — ukážu vám volné termíny.",
  en: "That time has already passed. Please choose a different time — I can show you available slots.",
};

function resolveLocaleKey(locale?: string | null): "ru" | "cs" | "en" {
  const n = String(locale ?? "").toLowerCase();
  if (n.startsWith("cs")) return "cs";
  if (n.startsWith("en")) return "en";
  return "ru";
}

export function buildPastTimeReply(locale?: string | null): string {
  return PAST_TIME_REPLIES[resolveLocaleKey(locale)];
}

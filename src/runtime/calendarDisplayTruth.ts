export type CalendarWeekdayCode =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface CalendarLocalizedText {
  ru: string;
  uk: string;
  cs: string;
  en: string;
}

export interface CalendarDisplayTruth {
  date: string;
  weekday_code: CalendarWeekdayCode;
  weekday: CalendarLocalizedText;
  date_display: CalendarLocalizedText;
}

const LOCALE_MAP: Record<keyof CalendarLocalizedText, string> = {
  ru: "ru-RU",
  uk: "uk-UA",
  cs: "cs-CZ",
  en: "en-US",
};

const WEEKDAY_CODES: CalendarWeekdayCode[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Parse a clinic-local calendar date without allowing JavaScript Date overflow.
 * The input is a calendar label, not an instant, so noon UTC is used only as a
 * stable formatting anchor and is never exposed as appointment time truth.
 */
function parseStrictCalendarDate(date: string): Date | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(value.getTime())) return null;

  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return null;
  }

  return value;
}

export function getCalendarWeekdayCode(date: string | null | undefined): CalendarWeekdayCode | null {
  if (!date) return null;
  const parsed = parseStrictCalendarDate(date);
  if (!parsed) return null;
  return WEEKDAY_CODES[parsed.getUTCDay()] ?? null;
}

/**
 * Canonical patient-facing calendar truth for a YYYY-MM-DD clinic-local date.
 * Runtime computes weekday/date labels once; the model should present these values,
 * never recompute weekday arithmetic from prose or conversation history.
 */
export function buildCalendarDisplayTruth(date: string | null | undefined): CalendarDisplayTruth | null {
  if (!date) return null;
  const parsed = parseStrictCalendarDate(date);
  if (!parsed) return null;

  const weekdayCode = WEEKDAY_CODES[parsed.getUTCDay()] ?? null;
  if (!weekdayCode) return null;

  const weekday: CalendarLocalizedText = { ru: "", uk: "", cs: "", en: "" };
  const dateDisplay: CalendarLocalizedText = { ru: "", uk: "", cs: "", en: "" };

  for (const lang of Object.keys(LOCALE_MAP) as Array<keyof CalendarLocalizedText>) {
    const locale = LOCALE_MAP[lang];
    weekday[lang] = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone: "UTC",
    }).format(parsed);
    dateDisplay[lang] = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(parsed);
  }

  return {
    date,
    weekday_code: weekdayCode,
    weekday,
    date_display: dateDisplay,
  };
}

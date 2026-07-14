import type { RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import { hasCompleteBookingApplyProof } from "./bookingApplyGuard.ts";

export interface AppointmentDisplayTruth {
  source: "booking.apply";
  date: string;
  time_start: string;
  time_end?: string;
  weekday: {
    ru: string;
    uk: string;
    cs: string;
    en: string;
  };
  date_display: {
    ru: string;
    uk: string;
    cs: string;
    en: string;
  };
  service?: string;
  cliniccard_visit_id?: string;
  cliniccard_patient_id?: string;
}

const LOCALE_MAP: Record<keyof AppointmentDisplayTruth["weekday"], string> = {
  ru: "ru-RU",
  uk: "uk-UA",
  cs: "cs-CZ",
  en: "en-US",
};

function extractDateFromResult(data: Record<string, unknown>): string | null {
  // Try visit_start first: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS"
  const visitStart = data.visit_start;
  if (typeof visitStart === "string") {
    const m = visitStart.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  // Then requested_date or date: "YYYY-MM-DD"
  for (const key of ["requested_date", "date"]) {
    const val = data[key];
    if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  }
  return null;
}

function extractTimeFromResult(data: Record<string, unknown>, timeKey: "time_start" | "time_end"): string | null {
  // Try visit_start/visit_end first: "YYYY-MM-DD HH:MM:SS"
  const visitKey = timeKey === "time_start" ? "visit_start" : "visit_end";
  const visitVal = data[visitKey];
  if (typeof visitVal === "string") {
    const m = visitVal.match(/\s(\d{2}:\d{2})(?::\d{2})?$/);
    if (m) return m[1];
    const mt = visitVal.match(/T(\d{2}:\d{2})(?::\d{2})?/);
    if (mt) return mt[1];
  }
  // Then requested_time or time_start/time_end directly
  const altKey = timeKey === "time_start" ? "requested_time" : undefined;
  for (const key of [timeKey, altKey].filter(Boolean) as string[]) {
    const val = data[key];
    if (typeof val === "string" && /^\d{2}:\d{2}/.test(val)) return val.slice(0, 5);
  }
  return null;
}

function buildWeekdayAndDateDisplay(
  dateStr: string,
  _timezone: string,
): { weekday: AppointmentDisplayTruth["weekday"]; date_display: AppointmentDisplayTruth["date_display"] } | null {
  // Parse YYYY-MM-DD manually to avoid host-TZ shifting the calendar date.
  // dateStr is the appointment's local calendar date (e.g. "2026-07-07") as
  // returned by the backend — not a UTC instant. We anchor it to noon UTC so
  // that no host timezone (including UTC-12 through UTC+14) can roll it over
  // to a different calendar day when Intl formats it with timeZone:"UTC".
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [year, month, day] = parts;
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (isNaN(dt.getTime())) return null;

  const weekday: AppointmentDisplayTruth["weekday"] = { ru: "", uk: "", cs: "", en: "" };
  const date_display: AppointmentDisplayTruth["date_display"] = { ru: "", uk: "", cs: "", en: "" };

  for (const lang of Object.keys(LOCALE_MAP) as Array<keyof typeof LOCALE_MAP>) {
    const locale = LOCALE_MAP[lang];
    // timeZone:"UTC" is intentional: the date is already the appointment's
    // local calendar date; formatting in UTC preserves it regardless of
    // the host process TZ environment variable.
    weekday[lang] = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone: "UTC",
    }).format(dt);
    date_display[lang] = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(dt);
  }

  return { weekday, date_display };
}

export function buildAppointmentDisplayTruth(
  toolResults: RuntimeAgentToolResult[],
  timezone?: string,
): AppointmentDisplayTruth | null {
  const tz = timezone ?? "Europe/Prague";

  const bookingSuccess = toolResults.find(
    (r) => r.tool === "booking.apply" && r.status === "success" && r.data !== null && r.data !== undefined,
  );
  if (!bookingSuccess) return null;

  // Require complete ClinicCard proof — partial results (missing cliniccard_visit_id,
  // may_claim_booked=false, status≠success, etc.) must not produce appointment display
  // truth that could mislead the model into confirming an unverified booking.
  if (!hasCompleteBookingApplyProof(bookingSuccess)) return null;

  const data = bookingSuccess.data as Record<string, unknown>;
  if (typeof data !== "object" || Array.isArray(data)) return null;

  const date = extractDateFromResult(data);
  if (!date) return null;

  const time_start = extractTimeFromResult(data, "time_start");
  if (!time_start) return null;

  const time_end = extractTimeFromResult(data, "time_end") ?? undefined;

  const display = buildWeekdayAndDateDisplay(date, tz);
  if (!display) return null;

  const service =
    typeof data.service === "string" && data.service.trim()
      ? data.service.trim()
      : typeof data.note === "string" && data.note.trim()
        ? data.note.trim()
        : undefined;

  const cliniccard_visit_id =
    typeof data.cliniccard_visit_id === "string" && data.cliniccard_visit_id
      ? data.cliniccard_visit_id
      : undefined;

  const cliniccard_patient_id =
    typeof data.cliniccard_patient_id === "string" && data.cliniccard_patient_id
      ? data.cliniccard_patient_id
      : undefined;

  return {
    source: "booking.apply",
    date,
    time_start,
    ...(time_end ? { time_end } : {}),
    weekday: display.weekday,
    date_display: display.date_display,
    ...(service ? { service } : {}),
    ...(cliniccard_visit_id ? { cliniccard_visit_id } : {}),
    ...(cliniccard_patient_id ? { cliniccard_patient_id } : {}),
  };
}

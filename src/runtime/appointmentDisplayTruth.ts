import type { RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import { hasCompleteBookingApplyProof, findAuthoritativeBookingApplyResult } from "./bookingApplyGuard.ts";
import {
  buildCalendarDisplayTruth,
  type CalendarLocalizedText,
} from "./calendarDisplayTruth.ts";

export interface AppointmentDisplayTruth {
  source: "booking.apply";
  date: string;
  time_start: string;
  time_end?: string;
  weekday: CalendarLocalizedText;
  date_display: CalendarLocalizedText;
  service?: string;
  cliniccard_visit_id?: string;
  cliniccard_patient_id?: string;
}

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

export function buildAppointmentDisplayTruth(
  toolResults: RuntimeAgentToolResult[],
  _timezone?: string,
): AppointmentDisplayTruth | null {
  // Use the authoritative result: last with complete ClinicCard proof wins, so that a
  // successful round-2 result overrides a synthetic blocked round-1 result in toolResults.
  const bookingSuccess = findAuthoritativeBookingApplyResult(toolResults);
  // Require complete ClinicCard proof — partial results (missing cliniccard_visit_id,
  // may_claim_booked=false, status≠success, etc.) must not produce appointment display
  // truth that could mislead the model into confirming an unverified booking.
  if (!bookingSuccess || !hasCompleteBookingApplyProof(bookingSuccess)) return null;

  const data = bookingSuccess.data as Record<string, unknown>;
  if (typeof data !== "object" || Array.isArray(data)) return null;

  const date = extractDateFromResult(data);
  if (!date) return null;

  const time_start = extractTimeFromResult(data, "time_start");
  if (!time_start) return null;

  const time_end = extractTimeFromResult(data, "time_end") ?? undefined;

  const calendar = buildCalendarDisplayTruth(date);
  if (!calendar) return null;

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
    weekday: calendar.weekday,
    date_display: calendar.date_display,
    ...(service ? { service } : {}),
    ...(cliniccard_visit_id ? { cliniccard_visit_id } : {}),
    ...(cliniccard_patient_id ? { cliniccard_patient_id } : {}),
  };
}

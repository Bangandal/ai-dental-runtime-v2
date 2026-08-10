import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ToolExecutionContext, ToolExecutor, LookupBookingSubjectsView } from "../../runtime/toolExecutor.ts";
import type {
  AppointmentLookupSuccessResult,
  AppointmentLookupResult,
  AppointmentLookupAppointment,
  AppointmentLookupRequiredNextAction,
  AppointmentLookupStatus,
  ToolExecutionResult,
} from "../../runtime/toolResults.ts";

// Stricter than booking.apply: typed and shared_from_subject phones are not
// acceptable for lookup — only platform-verified or ClinicCard-verified contacts.
const TRUSTED_LOOKUP_PHONE_SOURCES: ReadonlySet<string> = new Set([
  "telegram_contact_button",
  "whatsapp_sender",
  "existing_cliniccard_patient",
]);

// Default forward horizon when no date_to provided.
const DEFAULT_HORIZON_DAYS = 180;

// Max date range that can be requested at once.
const MAX_RANGE_DAYS = 365;

// Valid subject IDs for appointment.lookup.
const VALID_SUBJECT_PATTERN = /^subject_([1-4])$/;

function isClinicAllowedForLookup(
  clinicId: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (!clinicId) return false;
  const raw = env["CLINICCARD_LIVE_CLINIC_ALLOWLIST"] ?? "";
  const allowlist = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return allowlist.includes(clinicId);
}

function clinicLocalDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function clinicLocalTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Validate and parse a strict YYYY-MM-DD date string.
// Returns null if invalid or impossible.
function parseStrictDate(s: string): { year: number; month: number; day: number } | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return null;
  return { year, month, day };
}

function dateStringToMs(s: string): number {
  // YYYY-MM-DD → UTC midnight
  const d = new Date(s + "T00:00:00Z");
  return d.getTime();
}

function msToDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type LookupResult = {
  status: AppointmentLookupStatus;
  may_claim_found: boolean;
  required_next_action: AppointmentLookupRequiredNextAction;
  appointments: AppointmentLookupAppointment[];
};

function buildResult(
  lookup_status: AppointmentLookupStatus,
  may_claim_found: boolean,
  required_next_action: AppointmentLookupRequiredNextAction,
  appointments: AppointmentLookupAppointment[],
  searched_range: { date_from: string; date_to: string },
): AppointmentLookupSuccessResult {
  return {
    tool: "appointment.lookup",
    status: "success",
    data: {
      appointment_action: "appointment_lookup",
      lookup_status,
      may_claim_found,
      required_next_action,
      appointments,
      searched_range,
    },
  };
}

function errorResult(code: string, message: string): ToolExecutionResult {
  return {
    tool: "appointment.lookup",
    status: "failed",
    error: { code, message, retryable: false },
  };
}

function formatAppointment(v: {
  id: number;
  date: string;
  time_start: string;
  time_end: string;
  status: string;
}): AppointmentLookupAppointment {
  return {
    cliniccard_visit_id: String(v.id),
    date: v.date,
    time_start: v.time_start,
    time_end: v.time_end,
    status: v.status as "PLANNED" | "CONFIRMED",
  };
}

// Resolve the phone number and source for a given subject_id.
// For subject_1 (or no registry): returns channel_contact phone.
// For subject_2+: returns the subject's own booking_contact (NOT following shared_from_subject).
function resolveSubjectPhone(
  subjectId: string,
  channelContactPhone: string | undefined,
  channelContactSource: string | undefined,
  registry: LookupBookingSubjectsView | null | undefined,
): { phone_number: string | undefined; phone_source: string | undefined } {
  if (subjectId === "subject_1" || !registry) {
    return { phone_number: channelContactPhone, phone_source: channelContactSource };
  }
  const subject = registry.subjects.find((s) => s.id === subjectId);
  if (!subject?.booking_contact) {
    return { phone_number: undefined, phone_source: undefined };
  }
  // Never follow shared_from_subject — return it as-is so the identity gate rejects it.
  return {
    phone_number: subject.booking_contact.phone_number,
    phone_source: subject.booking_contact.source,
  };
}

export interface AppointmentLookupExecutorDeps {
  env?: Record<string, string | undefined>;
  adapterFactory?: (config: ClinicCardConfig) => ClinicCardAdapter;
}

export function createAppointmentLookupExecutor(
  deps: AppointmentLookupExecutorDeps = {},
): ToolExecutor {
  return async (context: ToolExecutionContext): Promise<ToolExecutionResult> => {
    const env = deps.env ?? (process.env as Record<string, string | undefined>);
    const clinicTimezone = env["CLINICCARD_TIMEZONE"] ?? "Europe/Prague";
    const now = context.now ?? new Date();

    // A. Clinic allowlist gate.
    if (!isClinicAllowedForLookup(context.clinic_id, env)) {
      const placeholder: { date_from: string; date_to: string } = { date_from: "", date_to: "" };
      return buildResult("clinic_not_allowed", false, "technical_fallback", [], placeholder);
    }

    // B. subject_id validation — must be present and subject_1..4.
    const subjectId = context.lookup_subject_id;
    if (!subjectId) {
      return buildResult("subject_resolution_conflict", false, "clarify_subject", [], { date_from: "", date_to: "" });
    }
    if (!VALID_SUBJECT_PATTERN.test(subjectId)) {
      return buildResult("subject_resolution_conflict", false, "clarify_subject", [], { date_from: "", date_to: "" });
    }

    // B2. If booking_subjects registry exists, the exact subject must be present.
    //     If no registry exists, only subject_1 is valid.
    const registry = context.lookup_booking_subjects;
    if (subjectId !== "subject_1") {
      if (!registry) {
        // No multi-subject registry: only subject_1 is valid.
        return buildResult("subject_resolution_conflict", false, "clarify_subject", [], { date_from: "", date_to: "" });
      }
      const subjectExists = registry.subjects.some((s) => s.id === subjectId);
      if (!subjectExists) {
        return buildResult("subject_resolution_conflict", false, "clarify_subject", [], { date_from: "", date_to: "" });
      }
    }

    // C. Identity gate — resolve phone for the exact subject.
    //    shared_from_subject is intentionally NOT followed (invariant: must not borrow subject_1's phone).
    const { phone_number: resolvedPhone, phone_source: resolvedSource } = resolveSubjectPhone(
      subjectId,
      context.phone_number,
      context.phone_source,
      registry,
    );

    if (!resolvedPhone || !TRUSTED_LOOKUP_PHONE_SOURCES.has(resolvedSource ?? "")) {
      return buildResult("identity_not_verified", false, "ask_for_trusted_contact", [], { date_from: "", date_to: "" });
    }

    // D. Date range resolution and validation.
    const todayLocal = clinicLocalDate(now, clinicTimezone);

    let dateFrom: string;
    let dateTo: string;

    if (context.lookup_date_from !== undefined || context.lookup_date_to !== undefined) {
      // Explicit date args: validate both.
      const rawFrom = context.lookup_date_from;
      const rawTo = context.lookup_date_to;

      if (rawFrom !== undefined) {
        if (!parseStrictDate(rawFrom)) {
          return errorResult("invalid_date_range", `date_from "${rawFrom}" is not a valid YYYY-MM-DD date`);
        }
        dateFrom = rawFrom;
      } else {
        dateFrom = todayLocal;
      }

      if (rawTo !== undefined) {
        if (!parseStrictDate(rawTo)) {
          return errorResult("invalid_date_range", `date_to "${rawTo}" is not a valid YYYY-MM-DD date`);
        }
        dateTo = rawTo;
      } else {
        dateTo = msToDateString(dateStringToMs(dateFrom) + DEFAULT_HORIZON_DAYS * 86400000);
      }

      if (dateStringToMs(dateFrom) > dateStringToMs(dateTo)) {
        return errorResult("invalid_date_range", `date_from "${dateFrom}" must not be after date_to "${dateTo}"`);
      }

      const rangeDays = Math.round((dateStringToMs(dateTo) - dateStringToMs(dateFrom)) / 86400000);
      if (rangeDays > MAX_RANGE_DAYS) {
        return errorResult("invalid_date_range", `date range ${rangeDays} days exceeds maximum ${MAX_RANGE_DAYS} days`);
      }
    } else {
      // Default range: clinic-local today to today + 180 days.
      dateFrom = todayLocal;
      dateTo = msToDateString(dateStringToMs(todayLocal) + DEFAULT_HORIZON_DAYS * 86400000);
    }

    const searched_range = { date_from: dateFrom, date_to: dateTo };

    // E. ClinicCard config.
    const configResult = loadClinicCardConfig(env);
    if (!configResult.ok) {
      return buildResult("config_missing", false, "technical_fallback", [], searched_range);
    }
    const config = configResult.data;

    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    // F. Find patient by phone.
    const findResult = await adapter.findPatientByPhone(resolvedPhone);
    if (!findResult.ok) {
      return buildResult("cliniccard_read_failed", false, "technical_fallback", [], searched_range);
    }

    const patients = findResult.data;
    if (patients.length === 0) {
      return buildResult("patient_not_found", false, "admin_handoff", [], searched_range);
    }
    if (patients.length > 1) {
      return buildResult("multiple_patients", false, "admin_handoff", [], searched_range);
    }

    const patient = patients[0];

    // G. Fetch visits for the requested range.
    const visitsResult = await adapter.listVisits(dateFrom, dateTo);
    if (!visitsResult.ok) {
      return buildResult("cliniccard_read_failed", false, "technical_fallback", [], searched_range);
    }

    // H. Filter to this patient's actionable visits (PLANNED/CONFIRMED) only.
    //    Exclude same-day visits that have already passed (time_start < current clinic-local time).
    const currentTimeLocal = clinicLocalTime(now, clinicTimezone);

    const actionableVisits = visitsResult.data
      .filter((v) => {
        if (v.patient_id !== patient.id) return false;
        if (v.status !== "PLANNED" && v.status !== "CONFIRMED") return false;
        // Exclude past dates (before today).
        if (v.date < todayLocal) return false;
        // Same day: exclude if time_start has already passed.
        if (v.date === todayLocal && v.time_start < currentTimeLocal) return false;
        return true;
      })
      .sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date);
        return dateCmp !== 0 ? dateCmp : a.time_start.localeCompare(b.time_start);
      });

    if (actionableVisits.length === 0) {
      return buildResult("no_upcoming_appointments", false, "none", [], searched_range);
    }

    if (actionableVisits.length === 1) {
      return buildResult("single_match", true, "none", actionableVisits.map(formatAppointment), searched_range);
    }

    return buildResult("multiple_matches", true, "ask_which_appointment", actionableVisits.map(formatAppointment), searched_range);
  };
}

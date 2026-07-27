import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ClinicCardConfig, ClinicCardVisit } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ToolExecutionContext, ToolExecutor } from "../../runtime/toolExecutor.ts";
import type { AppointmentLookupSuccessResult, AppointmentLookupVisit, ToolExecutionResult } from "../../runtime/toolResults.ts";

// Stricter than booking.apply: typed and shared_from_subject phones are not
// acceptable for lookup — only platform-verified or ClinicCard-verified contacts.
const TRUSTED_LOOKUP_PHONE_SOURCES: ReadonlySet<string> = new Set([
  "telegram_contact_button",
  "whatsapp_sender",
  "existing_cliniccard_patient",
]);

// How far ahead to search for upcoming visits.
const LOOKUP_HORIZON_DAYS = 180;

// Statuses that represent actionable upcoming visits.
const ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["PLANNED", "CONFIRMED"]);

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

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lookupResult(
  lookupStatus: AppointmentLookupSuccessResult["data"]["lookup_status"],
  extra: { visits: AppointmentLookupSuccessResult["data"]["visits"]; reason?: string },
): AppointmentLookupSuccessResult {
  return {
    tool: "appointment.lookup",
    status: "success",
    data: { lookup_status: lookupStatus, ...extra },
  };
}

function errorResult(code: string, message: string): ToolExecutionResult {
  return {
    tool: "appointment.lookup",
    status: "failed",
    error: { code, message, retryable: false },
  };
}

function formatVisit(v: ClinicCardVisit): AppointmentLookupVisit {
  return {
    visit_id: String(v.id),
    date: v.date,
    time_start: v.time_start,
    time_end: v.time_end,
    status: v.status as "PLANNED" | "CONFIRMED",
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

    // A. Clinic allowlist gate — lookup is only permitted for allowlisted clinics.
    if (!isClinicAllowedForLookup(context.clinic_id, env)) {
      return lookupResult("clinic_not_allowed", {
        reason: context.clinic_id
          ? `clinic_id "${context.clinic_id}" is not in CLINICCARD_LIVE_CLINIC_ALLOWLIST`
          : "clinic_id is missing; cannot verify CLINICCARD_LIVE_CLINIC_ALLOWLIST membership",
        visits: [],
      });
    }

    // B. Identity gate — stricter than booking.apply: typed and shared_from_subject denied.
    const phoneNumber = context.phone_number;
    const phoneSource = context.phone_source ?? "";
    if (!phoneNumber || !TRUSTED_LOOKUP_PHONE_SOURCES.has(phoneSource)) {
      return lookupResult("identity_not_verified", {
        reason: phoneNumber
          ? `phone_source "${phoneSource}" is not a trusted identity proof for appointment lookup`
          : "no trusted phone available for identity verification",
        visits: [],
      });
    }

    // C. ClinicCard config — need API credentials (not booking mode).
    const configResult = loadClinicCardConfig(env);
    if (!configResult.ok) {
      return errorResult("config_missing", configResult.error.message);
    }
    const config = configResult.data;

    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    // D. Find patient by phone.
    const findResult = await adapter.findPatientByPhone(phoneNumber);
    if (!findResult.ok) {
      return errorResult("cliniccard_error", findResult.error.message);
    }

    const patients = findResult.data;
    if (patients.length === 0) {
      return lookupResult("not_found", { visits: [] });
    }
    if (patients.length > 1) {
      return lookupResult("multiple_patients", { visits: [] });
    }

    const patient = patients[0];

    // E. Fetch visits for next LOOKUP_HORIZON_DAYS days.
    const now = context.now ?? new Date();
    const fromDate = toISODate(now);
    const toDate = toISODate(addDays(now, LOOKUP_HORIZON_DAYS));

    const visitsResult = await adapter.listVisits(fromDate, toDate);
    if (!visitsResult.ok) {
      return errorResult("cliniccard_error", visitsResult.error.message);
    }

    // F. Filter to this patient's actionable visits only.
    // Privacy: visit objects returned by formatVisit never include patient_id,
    // doctor_id, cabinet_id, note, or any personal identifying field.
    const actionableVisits = visitsResult.data
      .filter(
        (v) =>
          v.patient_id === patient.id &&
          ACTIONABLE_STATUSES.has(v.status),
      )
      .sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date);
        return dateCmp !== 0 ? dateCmp : a.time_start.localeCompare(b.time_start);
      });

    if (actionableVisits.length === 0) {
      return lookupResult("no_upcoming_visits", { visits: [] });
    }

    return lookupResult("found", {
      visits: actionableVisits.map(formatVisit),
    });
  };
}

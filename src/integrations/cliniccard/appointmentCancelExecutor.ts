import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ToolExecutionContext, ToolExecutor, LookupBookingSubjectsView } from "../../runtime/toolExecutor.ts";
import type {
  AppointmentCancelSuccessResult,
  AppointmentCancelResult,
  AppointmentCancelStatus,
  AppointmentCancelRequiredNextAction,
  ToolExecutionResult,
} from "../../runtime/toolResults.ts";

// Same trusted sources as appointment.lookup — shared_from_subject is never allowed.
const TRUSTED_CANCEL_PHONE_SOURCES: ReadonlySet<string> = new Set([
  "telegram_contact_button",
  "whatsapp_sender",
  "existing_cliniccard_patient",
]);

const VALID_SUBJECT_PATTERN = /^subject_([1-4])$/;

function isClinicAllowedForCancel(
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

function isLiveModeEnabled(env: Record<string, string | undefined>): boolean {
  return env["CLINICCARD_BOOKING_MODE"] === "live";
}

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
  // Never follow shared_from_subject — return it so the identity gate rejects it.
  return {
    phone_number: subject.booking_contact.phone_number,
    phone_source: subject.booking_contact.source,
  };
}

function buildResult(
  cancel_status: AppointmentCancelStatus,
  cancelled: boolean,
  may_claim_cancelled: boolean,
  cliniccard_visit_id: string | null,
  required_next_action: AppointmentCancelRequiredNextAction,
): AppointmentCancelSuccessResult {
  return {
    tool: "appointment.cancel",
    status: "success",
    data: {
      appointment_action: "appointment_cancel",
      cancel_status,
      cancelled,
      may_claim_cancelled,
      cancelled_visit_id: cliniccard_visit_id,
      required_next_action,
    },
  };
}

function errorResult(code: string, message: string): ToolExecutionResult {
  return {
    tool: "appointment.cancel",
    status: "failed",
    error: { code, message, retryable: false },
  };
}

export interface AppointmentCancelExecutorDeps {
  env?: Record<string, string | undefined>;
  adapterFactory?: (config: ClinicCardConfig) => ClinicCardAdapter;
}

export function createAppointmentCancelExecutor(
  deps: AppointmentCancelExecutorDeps = {},
): ToolExecutor {
  return async (context: ToolExecutionContext): Promise<ToolExecutionResult> => {
    const env = deps.env ?? (process.env as Record<string, string | undefined>);

    // A. Clinic allowlist gate — same allowlist as appointment.lookup.
    if (!isClinicAllowedForCancel(context.clinic_id, env)) {
      return buildResult("clinic_not_allowed", false, false, null, "technical_fallback");
    }

    // B. Live mode gate — cancellation requires CLINICCARD_BOOKING_MODE=live.
    if (!isLiveModeEnabled(env)) {
      return buildResult("live_mode_required", false, false, null, "technical_fallback");
    }

    // C. subject_id validation.
    const subjectId = context.cancel_subject_id;
    if (!subjectId || !VALID_SUBJECT_PATTERN.test(subjectId)) {
      return buildResult("subject_resolution_conflict", false, false, null, "clarify_subject");
    }

    // D. Multi-subject registry: validate subject exists when registry is present.
    const registry = context.lookup_booking_subjects;
    if (subjectId !== "subject_1") {
      if (!registry) {
        return buildResult("subject_resolution_conflict", false, false, null, "clarify_subject");
      }
      const subjectExists = registry.subjects.some((s) => s.id === subjectId);
      if (!subjectExists) {
        return buildResult("subject_resolution_conflict", false, false, null, "clarify_subject");
      }
    }

    // E. Identity gate — phone must come from a trusted channel source.
    const { phone_number: resolvedPhone, phone_source: resolvedSource } = resolveSubjectPhone(
      subjectId,
      context.phone_number,
      context.phone_source,
      registry,
    );

    if (!resolvedPhone || !TRUSTED_CANCEL_PHONE_SOURCES.has(resolvedSource ?? "")) {
      return buildResult("identity_not_verified", false, false, null, "ask_for_trusted_contact");
    }

    // F. Lookup proof gate — must have an authoritative single_match from same turn.
    const lookupProof = context.cancel_lookup_proof;
    if (!lookupProof) {
      return buildResult("lookup_not_verified", false, false, null, "refresh_lookup");
    }

    if (lookupProof.lookup_status !== "single_match") {
      if (lookupProof.lookup_status === "multiple_matches") {
        return buildResult("multiple_matches", false, false, null, "ask_which_appointment");
      }
      return buildResult("appointment_not_found", false, false, null, "refresh_lookup");
    }

    // G. visit_id must be present in context and match the lookup proof exactly.
    const requestedVisitId = context.cancel_visit_id;
    if (!requestedVisitId) {
      return buildResult("verification_failed", false, false, null, "refresh_lookup");
    }

    if (lookupProof.appointments.length !== 1) {
      return buildResult("appointment_not_found", false, false, null, "refresh_lookup");
    }

    const proofAppointment = lookupProof.appointments[0];
    if (proofAppointment.cliniccard_visit_id !== requestedVisitId) {
      return buildResult("verification_failed", false, false, requestedVisitId, "refresh_lookup");
    }

    // H. Appointment must be in an actionable status (PLANNED or CONFIRMED).
    if (proofAppointment.status !== "PLANNED" && proofAppointment.status !== "CONFIRMED") {
      return buildResult("appointment_not_actionable", false, false, requestedVisitId, "admin_handoff");
    }

    // I. ClinicCard config.
    const configResult = loadClinicCardConfig(env);
    if (!configResult.ok) {
      return buildResult("cliniccard_write_failed", false, false, requestedVisitId, "technical_fallback");
    }
    const config = configResult.data;

    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    // J. Execute DELETE /api/visits.
    const deleteResult = await adapter.deleteVisit(requestedVisitId);
    if (!deleteResult.ok) {
      return buildResult("cliniccard_write_failed", false, false, requestedVisitId, "technical_fallback");
    }

    // K. Post-write verification: confirm the visit is absent from listVisits on the appointment date.
    const visitDate = proofAppointment.date;
    const verifyResult = await adapter.listVisits(visitDate, visitDate);
    if (!verifyResult.ok) {
      // Read-back verification failed — the delete may have succeeded, but we cannot
      // confirm it authoritatively. Do NOT claim cancellation without proof.
      return buildResult("verification_failed", false, false, requestedVisitId, "technical_fallback");
    }

    const visitStillPresent = verifyResult.data.some(
      (v) => String(v.id) === requestedVisitId,
    );

    if (visitStillPresent) {
      return buildResult("verification_failed", false, false, requestedVisitId, "admin_handoff");
    }

    return buildResult("cancelled", true, true, requestedVisitId, "none");
  };
}

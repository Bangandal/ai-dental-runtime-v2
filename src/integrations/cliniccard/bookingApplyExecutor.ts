import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import { createClinicCardPatientIdentityAuthority } from "./clinicCardPatientIdentityAuthority.ts";
import { createClinicCardBookingWriteAuthority } from "./clinicCardBookingWriteAuthority.ts";
import { resolveClinicCardBookingSlotPolicy } from "./clinicCardBookingSlotPolicy.ts";
import { resolveClinicCardServiceResource } from "./clinicCardServiceResourcePolicy.ts";
import type { ToolExecutionContext, ToolExecutor } from "../../runtime/toolExecutor.ts";
import type { BookingApplyResult, BookingApplySuccessResult } from "../../runtime/toolResults.ts";
import type { PatientIdentityAuthority } from "../../runtime/patientIdentityAuthority.ts";
import type { BookingWriteAuthority } from "../../runtime/bookingWriteAuthority.ts";
import type {
  BookingReconciliationGuard,
  BookingReconciliationKey,
  BookingReconciliationLock,
} from "../../runtime/bookingReconciliationCoordinator.ts";
import { acquireBookingSlotLock } from "./bookingSlotMutex.ts";

// Strict HH:MM, exactly two-digit hour and minute, valid range.
// Rejects "9:00", "10am", "morning", and any natural-language string.
function parseStrictHHMM(val: string): string | null {
  const m = val.trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${m[1]}:${m[2]}`;
}

function timeToMinutes(time: string): number {
  const sep = time.indexOf(":");
  const h = parseInt(time.slice(0, sep), 10);
  const m = parseInt(time.slice(sep + 1), 10);
  return h * 60 + m;
}

function bookingResult(partial: Omit<BookingApplyResult, "booking_action">): BookingApplySuccessResult {
  return {
    tool: "booking.apply",
    status: "success",
    data: { booking_action: "booking_apply", ...partial },
  };
}

function reconciliationBlockedResult(
  lock: BookingReconciliationLock,
  timezone: string,
): BookingApplySuccessResult {
  return bookingResult({
    booking_status: "booking_outcome_unknown",
    created_visit: false,
    may_claim_booked: false,
    cliniccard_visit_id: null,
    ...(lock.patient_id !== undefined ? { cliniccard_patient_id: lock.patient_id } : {}),
    date: lock.date,
    time_start: lock.time_start,
    time_end: lock.time_end,
    doctor_id: lock.doctor_id,
    cabinet_id: lock.cabinet_id,
    timezone,
    reason: "A previous ClinicCard booking write is still awaiting reconciliation. Automatic retry is blocked to prevent a duplicate visit.",
    proof: null,
  });
}

async function reconcilePendingVisit(
  adapter: ClinicCardAdapter,
  guard: BookingReconciliationGuard,
  key: BookingReconciliationKey,
  lock: BookingReconciliationLock,
  timezone: string,
): Promise<BookingApplySuccessResult | null> {
  // Without a patient id we cannot uniquely attribute a ClinicCard visit to this
  // write. Keep the lock and require operator reconciliation rather than guessing.
  if (lock.patient_id === undefined) return null;

  const visitsResult = await adapter.listVisits(lock.date, lock.date);
  if (!visitsResult.ok) return null;

  const exactMatches = visitsResult.data.filter((visit) =>
    visit.status !== "UNKNOWN"
    && visit.patient_id === lock.patient_id
    && visit.doctor_id === lock.doctor_id
    && visit.cabinet_id === lock.cabinet_id
    && visit.date === lock.date
    && visit.time_start === lock.time_start
    && visit.time_end === lock.time_end,
  );

  // A missing read can be stale, and multiple matches indicate an anomaly. Neither
  // authorizes a retry or an automatic unlock. Only one exact authoritative visit does.
  if (exactMatches.length !== 1) return null;

  const visit = exactMatches[0];
  const cleared = await guard.clear(key);
  return bookingResult({
    booking_status: "visit_created",
    created_visit: true,
    may_claim_booked: true,
    cliniccard_visit_id: String(visit.id),
    cliniccard_patient_id: lock.patient_id,
    date: visit.date,
    time_start: visit.time_start,
    time_end: visit.time_end,
    doctor_id: visit.doctor_id,
    cabinet_id: visit.cabinet_id,
    timezone,
    reason: cleared.ok
      ? "ClinicCard visit confirmed by reconciliation after an earlier unknown write outcome"
      : `ClinicCard visit confirmed by reconciliation; durable lock could not be cleared yet: ${cleared.reason}`,
    proof: {
      cliniccard_visit_id: String(visit.id),
      cliniccard_patient_id: lock.patient_id,
      date: visit.date,
      time_start: visit.time_start,
      time_end: visit.time_end,
      reconciled_after_unknown_write: true,
    },
  });
}

export const TRUSTED_PHONE_SOURCES: ReadonlySet<string> = new Set([
  "telegram_contact_button",
  "whatsapp_sender",
  "voice_sip_caller",
  "existing_cliniccard_patient",
]);

function isClinicAllowedForLiveBooking(
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

export interface BookingApplyExecutorDeps {
  env?: Record<string, string | undefined>;
  adapterFactory?: (config: ClinicCardConfig) => ClinicCardAdapter;
  patientIdentityAuthorityFactory?: (adapter: ClinicCardAdapter) => PatientIdentityAuthority;
  bookingWriteAuthorityFactory?: (adapter: ClinicCardAdapter) => BookingWriteAuthority;
  bookingReconciliationGuard?: BookingReconciliationGuard;
}

export function createBookingApplyExecutor(deps: BookingApplyExecutorDeps = {}): ToolExecutor {
  return async (context: ToolExecutionContext): Promise<BookingApplySuccessResult> => {
    const configResult = loadClinicCardConfig(deps.env);
    if (!configResult.ok) {
      return bookingResult({
        booking_status: "config_missing",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: configResult.error.message,
        proof: null,
      });
    }
    const config = configResult.data;

    if (config.booking_mode !== "live") {
      return bookingResult({
        booking_status: "booking_write_disabled",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: `CLINICCARD_BOOKING_MODE is "${config.booking_mode}", not "live"`,
        proof: null,
      });
    }

    const env = deps.env ?? (process.env as Record<string, string | undefined>);
    if (!isClinicAllowedForLiveBooking(context.clinic_id, env)) {
      return bookingResult({
        booking_status: "booking_write_disabled",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: context.clinic_id
          ? `clinic_id "${context.clinic_id}" is not in CLINICCARD_LIVE_CLINIC_ALLOWLIST`
          : "clinic_id is missing; cannot verify CLINICCARD_LIVE_CLINIC_ALLOWLIST membership",
        proof: null,
      });
    }

    const phoneNumber = context.phone_number;
    if (!phoneNumber) {
      return bookingResult({
        booking_status: "missing_phone",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: "phone_number is required for booking; capture it via the channel contact mechanism",
        proof: null,
      });
    }

    const isVerifiedPhone = TRUSTED_PHONE_SOURCES.has(context.phone_source ?? "");
    const isProvidedTypedPhone = context.phone_source === "typed" && context.phone_trust === "unverified";
    if (!isVerifiedPhone && !isProvidedTypedPhone) {
      return bookingResult({
        booking_status: "missing_phone",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: `phone_source "${context.phone_source ?? "unknown"}" is not a trusted contact proof for live booking; capture phone via the channel contact mechanism or have the patient type their phone number`,
        proof: null,
      });
    }

    const serviceResource = resolveClinicCardServiceResource(deps.env, context.service_interest);
    if (!serviceResource.ok) {
      return bookingResult({
        booking_status: "config_missing",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: serviceResource.reason,
        proof: null,
      });
    }
    const doctorId = serviceResource.doctor_id;
    const cabinetId = serviceResource.cabinet_id;

    const firstName = context.first_name;
    const lastName = context.last_name;
    if (!firstName || !lastName) {
      const missing = [!firstName && "first_name", !lastName && "last_name"].filter(Boolean).join(", ");
      return bookingResult({
        booking_status: "config_missing",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: `Patient name fields required for createPatient: ${missing}`,
        proof: null,
      });
    }

    const requestedDate = context.requested_date;
    if (!requestedDate) {
      return bookingResult({
        booking_status: "config_missing",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: "requested_date is required",
        proof: null,
      });
    }

    const rawTime = context.requested_time;
    const timeStart = rawTime ? parseStrictHHMM(rawTime) : null;
    if (!timeStart) {
      return bookingResult({
        booking_status: "config_missing",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: `requested_time must be strict HH:MM (got: ${JSON.stringify(rawTime)})`,
        proof: null,
      });
    }

    const timezone = config.timezone || "Europe/Prague";
    const slotPolicyResult = resolveClinicCardBookingSlotPolicy(
      deps.env,
      requestedDate,
      timeStart,
      serviceResource.duration_minutes,
    );
    if (!slotPolicyResult.ok) {
      return bookingResult({
        booking_status: slotPolicyResult.failure === "policy_unavailable" ? "config_missing" : "slot_conflict",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: slotPolicyResult.reason,
        proof: null,
      });
    }
    const timeEnd = slotPolicyResult.time_end;

    const reconciliationKey: BookingReconciliationKey = {
      clinic_id: context.clinic_id ?? "",
      contact_id: context.contact_id,
      case_id: context.case_id,
    };

    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    if (deps.bookingReconciliationGuard) {
      const pending = await deps.bookingReconciliationGuard.getPending(reconciliationKey);
      if (!pending.ok) {
        return bookingResult({
          booking_status: "cliniccard_write_failed",
          created_visit: false,
          may_claim_booked: false,
          cliniccard_visit_id: null,
          reason: `Durable booking reconciliation guard is unavailable: ${pending.reason}`,
          proof: null,
        });
      }
      if (pending.lock) {
        const reconciled = await reconcilePendingVisit(
          adapter,
          deps.bookingReconciliationGuard,
          reconciliationKey,
          pending.lock,
          timezone,
        );
        if (reconciled) return reconciled;
        return reconciliationBlockedResult(pending.lock, timezone);
      }
    }

    const patientIdentityAuthorityFactory =
      deps.patientIdentityAuthorityFactory ?? createClinicCardPatientIdentityAuthority;
    const patientIdentityAuthority = patientIdentityAuthorityFactory(adapter);
    const bookingWriteAuthorityFactory =
      deps.bookingWriteAuthorityFactory ?? createClinicCardBookingWriteAuthority;
    const bookingWriteAuthority = bookingWriteAuthorityFactory(adapter);

    const release = await acquireBookingSlotLock(
      context.clinic_id ?? "",
      requestedDate,
      doctorId,
      cabinetId,
    );
    try {
      const visitsResult = await adapter.listVisits(requestedDate, requestedDate);
      if (!visitsResult.ok) {
        return bookingResult({
          booking_status: "cliniccard_write_failed",
          created_visit: false,
          may_claim_booked: false,
          cliniccard_visit_id: null,
          reason: `Availability re-read failed: ${visitsResult.error.message}`,
          proof: null,
        });
      }

      const slotStartMin = timeToMinutes(timeStart);
      const slotEndMin = timeToMinutes(timeEnd);
      const conflicts = visitsResult.data.filter((v) => {
        if (v.doctor_id !== doctorId && v.cabinet_id !== cabinetId) return false;
        return slotStartMin < timeToMinutes(v.time_end) && slotEndMin > timeToMinutes(v.time_start);
      });

      if (conflicts.length > 0) {
        return bookingResult({
          booking_status: "slot_conflict",
          created_visit: false,
          may_claim_booked: false,
          cliniccard_visit_id: null,
          reason: `Slot ${requestedDate} ${timeStart}–${timeEnd} conflicts with ${conflicts.length} existing visit(s)`,
          proof: null,
        });
      }

      const phoneBelongsToPatient = context.phone_belongs_to_patient
        ?? (context.contact_phone_owner_subject_id ? false : true);
      const identityResult = await patientIdentityAuthority.resolve({
        first_name: firstName,
        last_name: lastName,
        phone_number: phoneNumber,
        phone_belongs_to_patient: phoneBelongsToPatient,
      });

      if (!identityResult.ok) {
        return bookingResult({
          booking_status:
            identityResult.failure === "identity_ambiguous"
              ? "identity_ambiguous"
              : "cliniccard_write_failed",
          created_visit: false,
          may_claim_booked: false,
          cliniccard_visit_id: null,
          reason: identityResult.reason,
          proof: null,
        });
      }

      let reconciliationArmed = false;
      if (deps.bookingReconciliationGuard) {
        const lock: BookingReconciliationLock = {
          status: "pending",
          armed_at: (context.now ?? new Date()).toISOString(),
          reason: "write_in_flight_or_outcome_unknown",
          date: requestedDate,
          time_start: timeStart,
          time_end: timeEnd,
          doctor_id: doctorId,
          cabinet_id: cabinetId,
          service_interest: context.service_interest ?? null,
          ...(identityResult.resolution === "existing_patient" ? { patient_id: identityResult.patient_id } : {}),
        };
        const armed = await deps.bookingReconciliationGuard.arm(reconciliationKey, lock);
        if (!armed.ok) {
          return bookingResult({
            booking_status: "cliniccard_write_failed",
            created_visit: false,
            may_claim_booked: false,
            cliniccard_visit_id: null,
            date: requestedDate,
            time_start: timeStart,
            time_end: timeEnd,
            doctor_id: doctorId,
            cabinet_id: cabinetId,
            timezone,
            reason: `ClinicCard write was not attempted because the durable reconciliation lock could not be armed: ${armed.reason}`,
            proof: null,
          });
        }
        reconciliationArmed = true;
      }

      const writeResult = await bookingWriteAuthority.write({
        patient: identityResult.resolution === "existing_patient"
          ? {
              kind: "existing_patient",
              patient_id: identityResult.patient_id,
            }
          : {
              kind: "create_patient",
              name: `${firstName} ${lastName}`,
              phone_number: phoneNumber,
            },
        visit: {
          doctor_id: doctorId,
          cabinet_id: cabinetId,
          date: requestedDate,
          time_start: timeStart,
          time_end: timeEnd,
          status: "PLANNED",
          note: context.service_interest ?? undefined,
        },
      });

      if (!writeResult.ok) {
        const outcomeUnknown =
          writeResult.failure === "patient_write_outcome_unknown"
          || writeResult.failure === "visit_write_outcome_unknown";

        let reconciliationBindingFailure: string | null = null;
        if (
          writeResult.failure === "visit_write_outcome_unknown"
          && writeResult.patient_id !== undefined
          && reconciliationArmed
          && deps.bookingReconciliationGuard
        ) {
          const attached = await deps.bookingReconciliationGuard.attachPatientId(
            reconciliationKey,
            writeResult.patient_id,
          );
          if (!attached.ok) reconciliationBindingFailure = attached.reason;
        }

        // Known failures are safe to unlock. Unknown outcomes deliberately retain the
        // durable write-ahead lock so later turns cannot repeat the POST blindly.
        if (!outcomeUnknown && reconciliationArmed && deps.bookingReconciliationGuard) {
          await deps.bookingReconciliationGuard.clear(reconciliationKey);
        }

        return bookingResult({
          booking_status: outcomeUnknown ? "booking_outcome_unknown" : "cliniccard_write_failed",
          created_visit: false,
          may_claim_booked: false,
          cliniccard_visit_id: null,
          ...(writeResult.patient_id !== undefined ? { cliniccard_patient_id: writeResult.patient_id } : {}),
          date: requestedDate,
          time_start: timeStart,
          time_end: timeEnd,
          doctor_id: doctorId,
          cabinet_id: cabinetId,
          timezone,
          reason: outcomeUnknown
            ? `ClinicCard write outcome is unknown; durable reconciliation lock retained and automatic retry blocked. ${writeResult.reason}${reconciliationBindingFailure ? ` Patient id could not be bound to the reconciliation lock: ${reconciliationBindingFailure}` : ""}`
            : writeResult.reason,
          proof: null,
        });
      }

      if (reconciliationArmed && deps.bookingReconciliationGuard) {
        // Outcome is known successful. Failure to clear is conservative: the visit proof
        // remains valid, while a stale lock can only block a future write until reconciled.
        await deps.bookingReconciliationGuard.clear(reconciliationKey);
      }

      const patientId = writeResult.patient_id;
      const visit = writeResult.visit;
      return bookingResult({
        booking_status: "visit_created",
        created_visit: true,
        may_claim_booked: true,
        cliniccard_visit_id: String(visit.id),
        cliniccard_patient_id: patientId,
        date: visit.date,
        time_start: visit.time_start,
        time_end: visit.time_end,
        doctor_id: visit.doctor_id,
        cabinet_id: visit.cabinet_id,
        timezone,
        reason: "visit created in ClinicCard",
        proof: {
          cliniccard_visit_id: String(visit.id),
          cliniccard_patient_id: patientId,
          date: visit.date,
          time_start: visit.time_start,
          time_end: visit.time_end,
        },
      });
    } finally {
      release();
    }
  };
}

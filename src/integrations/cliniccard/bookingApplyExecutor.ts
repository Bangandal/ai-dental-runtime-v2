import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import { createClinicCardPatientIdentityAuthority } from "./clinicCardPatientIdentityAuthority.ts";
import { createClinicCardBookingWriteAuthority } from "./clinicCardBookingWriteAuthority.ts";
import type { ToolExecutionContext, ToolExecutor } from "../../runtime/toolExecutor.ts";
import type { BookingApplyResult, BookingApplySuccessResult } from "../../runtime/toolResults.ts";
import type { PatientIdentityAuthority } from "../../runtime/patientIdentityAuthority.ts";
import type { BookingWriteAuthority } from "../../runtime/bookingWriteAuthority.ts";
import { acquireBookingSlotLock } from "./bookingSlotMutex.ts";

const DEFAULT_SLOT_DURATION_MINUTES = 30;

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

function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function addMinutes(hhmm: string, mins: number): string {
  return minutesToHHMM(timeToMinutes(hhmm) + mins);
}

function bookingResult(partial: Omit<BookingApplyResult, "booking_action">): BookingApplySuccessResult {
  return {
    tool: "booking.apply",
    status: "success",
    data: { booking_action: "booking_apply", ...partial },
  };
}

// Phone sources that represent a platform-verified or ClinicCard-verified contact.
// "manual_input" (patient free-typed a number) is intentionally excluded, live writes
// require a stronger proof of contact than unverified free text.
// Exported so the booking contact guard can reuse the same authoritative set.
export const TRUSTED_PHONE_SOURCES: ReadonlySet<string> = new Set([
  "telegram_contact_button",
  "whatsapp_sender",
  "existing_cliniccard_patient",
]);

/**
 * Live ClinicCard writes are only permitted for clinic_ids explicitly allowlisted via
 * CLINICCARD_LIVE_CLINIC_ALLOWLIST (comma-separated). Fails closed: unset/empty allowlist
 * means no clinic is permitted, since this runtime is multi-tenant but live writes hit a
 * single shared ClinicCard account.
 */
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
}

export function createBookingApplyExecutor(deps: BookingApplyExecutorDeps = {}): ToolExecutor {
  return async (context: ToolExecutionContext): Promise<BookingApplySuccessResult> => {
    // A. Mode gate, must be first check. No ClinicCard reads or writes occur before this.
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

    // A2. Clinic allowlist gate, must run before any read or write, and before the phone
    // check, so a non-allowlisted clinic never gets asked for contact info it can't use.
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

    // B2. Phone check, must be present, and from a trusted/verified source, before any write.
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

    // Allow booking if phone comes from a trusted source OR from a typed provided phone
    // (phone_source="typed", phone_trust="unverified"). Typed phones are patient-supplied
    // text and carry lower trust, but are the only option when booking for a third party.
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

    // C. Config resolution, doctor_id and cabinet_id from trusted env only, never from patient.
    const doctorId = Number(config.default_doctor_id);
    if (!Number.isFinite(doctorId) || !Number.isInteger(doctorId) || doctorId <= 0) {
      return bookingResult({
        booking_status: "config_missing",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: "CLINICCARD_DEFAULT_DOCTOR_ID is missing or not a positive integer",
        proof: null,
      });
    }

    const cabinetId = Number(config.default_cabinet_id);
    if (!Number.isFinite(cabinetId) || !Number.isInteger(cabinetId) || cabinetId <= 0) {
      return bookingResult({
        booking_status: "config_missing",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: "CLINICCARD_DEFAULT_CABINET_ID is missing or not a positive integer",
        proof: null,
      });
    }

    // Missing patient name fields, createVisit cannot proceed without them.
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

    // Strict HH:MM validation, rejects "9:00", "10am", "morning", or any non-exact format.
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
    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);
    const patientIdentityAuthorityFactory =
      deps.patientIdentityAuthorityFactory ?? createClinicCardPatientIdentityAuthority;
    const patientIdentityAuthority = patientIdentityAuthorityFactory(adapter);
    const bookingWriteAuthorityFactory =
      deps.bookingWriteAuthorityFactory ?? createClinicCardBookingWriteAuthority;
    const bookingWriteAuthority = bookingWriteAuthorityFactory(adapter);

    const timeEnd = addMinutes(timeStart, DEFAULT_SLOT_DURATION_MINUTES);

    // Acquire slot-level lock before any ClinicCard read or write.
    // Serializes on both doctor and cabinet dimensions, mirrors the conflict rule
    // (same doctor OR same cabinet). Different doctor+cabinet proceed independently.
    const release = await acquireBookingSlotLock(
      context.clinic_id ?? "",
      requestedDate,
      doctorId,
      cabinetId,
    );
    try {
      // D. Fresh re-read of ClinicCard visits for the requested date, never trust stale availability.
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

      // E. Conflict check: slotStart < V.time_end AND slotEnd > V.time_start AND (same doctor OR same cabinet).
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

      // F1. Resolve target-patient identity behind a deterministic read-only authority.
      // New callers provide an explicit ownership fact. The legacy subject marker remains
      // only as a compatibility fallback until runtimeAgentLoop stops emitting subjects.
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

      // F2. All external booking writes are owned by BookingWriteAuthority.
      // The executor provides only the already-resolved patient target + visit command.
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
        return bookingResult({
          booking_status: "cliniccard_write_failed",
          created_visit: false,
          may_claim_booked: false,
          cliniccard_visit_id: null,
          reason: writeResult.reason,
          proof: null,
        });
      }

      // G. Success, only here may may_claim_booked be true.
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

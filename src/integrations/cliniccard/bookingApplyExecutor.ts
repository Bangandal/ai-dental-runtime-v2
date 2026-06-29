import type { ClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import type { ToolExecutionContext, ToolExecutor } from "../../runtime/toolExecutor.ts";
import type { BookingApplyResult, BookingApplySuccessResult } from "../../runtime/toolResults.ts";

const DEFAULT_SLOT_DURATION_MINUTES = 30;

function timeToMinutes(time: string): number {
  const sep = time.indexOf(":");
  const h = parseInt(time.slice(0, sep), 10);
  const m = parseInt(time.slice(sep + 1), 10);
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
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

export interface BookingApplyExecutorDeps {
  env?: Record<string, string | undefined>;
  adapterFactory?: (config: ClinicCardConfig) => ClinicCardAdapter;
}

export function createBookingApplyExecutor(deps: BookingApplyExecutorDeps = {}): ToolExecutor {
  return async (context: ToolExecutionContext): Promise<BookingApplySuccessResult> => {
    // A. Mode gate — must be first check.
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

    // B. Required text inputs.
    const firstName = context.first_name;
    const lastName = context.last_name;
    const service = context.service_interest;
    const requestedDate = context.requested_date;
    const requestedTime = context.requested_time;

    const missing: string[] = [];
    if (!firstName) missing.push("first_name");
    if (!lastName) missing.push("last_name");
    if (!service) missing.push("service");
    if (!requestedDate) missing.push("requested_date");
    if (!requestedTime) missing.push("requested_time");

    if (missing.length > 0) {
      return bookingResult({
        booking_status: "validation_error",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: `Missing required fields: ${missing.join(", ")}`,
        proof: null,
      });
    }

    // B2. Phone check.
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

    // C. Config resolution — doctor_id and cabinet_id from trusted config only.
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

    const timezone = config.timezone || "Europe/Prague";
    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    const timeStart = requestedTime!;
    const timeEnd = addMinutes(timeStart, DEFAULT_SLOT_DURATION_MINUTES);

    // D. Fresh re-read of ClinicCard visits for the requested date.
    const visitsResult = await adapter.listVisits(requestedDate!, requestedDate!);
    if (!visitsResult.ok) {
      return bookingResult({
        booking_status: "cliniccard_unavailable",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: `Failed to read visits: ${visitsResult.error.message}`,
        proof: null,
      });
    }

    // E. Conflict check: slotStart < V.time_end AND slotEnd > V.time_start AND (doctor OR cabinet).
    const slotStartMin = timeToMinutes(timeStart);
    const slotEndMin = timeToMinutes(timeEnd);
    const conflicts = visitsResult.data.filter((v) => {
      if (v.doctor_id !== doctorId && v.cabinet_id !== cabinetId) return false;
      return slotStartMin < timeToMinutes(v.time_end) && slotEndMin > timeToMinutes(v.time_start);
    });

    if (conflicts.length > 0) {
      return bookingResult({
        booking_status: "availability_conflict",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: `Slot ${requestedDate} ${timeStart}–${timeEnd} conflicts with ${conflicts.length} existing visit(s)`,
        proof: null,
      });
    }

    // F. Create patient then visit.
    const patientResult = await adapter.createPatient({
      name: `${firstName} ${lastName}`,
      phone: phoneNumber,
    });

    if (!patientResult.ok) {
      return bookingResult({
        booking_status: "patient_create_failed",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: patientResult.error.message,
        proof: null,
      });
    }

    const patientId = patientResult.data.id;
    const visitResult = await adapter.createVisit({
      patient_id: patientId,
      doctor_id: doctorId,
      cabinet_id: cabinetId,
      date: requestedDate!,
      time_start: timeStart,
      time_end: timeEnd,
      status: "PLANNED",
      note: service ?? undefined,
    });

    if (!visitResult.ok) {
      return bookingResult({
        booking_status: "visit_create_failed",
        created_visit: false,
        may_claim_booked: false,
        cliniccard_visit_id: null,
        reason: visitResult.error.message,
        proof: null,
      });
    }

    // G. Success.
    const visit = visitResult.data;
    return bookingResult({
      booking_status: "visit_created",
      created_visit: true,
      may_claim_booked: true,
      cliniccard_visit_id: visit.id,
      cliniccard_patient_id: patientId,
      date: visit.date,
      time_start: visit.time_start,
      time_end: visit.time_end,
      doctor_id: visit.doctor_id,
      cabinet_id: visit.cabinet_id,
      timezone,
      reason: null,
      proof: {
        cliniccard_visit_id: visit.id,
        cliniccard_patient_id: patientId,
        date: visit.date,
        time_start: visit.time_start,
        time_end: visit.time_end,
      },
    });
  };
}

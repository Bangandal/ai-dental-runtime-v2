import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import { checkClinicCardAvailability, type AvailabilityAdapter } from "./clinicCardAvailability.ts";
import { getIsoWeekday, isDateInsideAvailabilityPolicy, loadClinicCardAvailabilityPolicy } from "./clinicCardAvailabilityPolicy.ts";
import {
  isDateInsideClinicCardServiceSchedule,
  resolveClinicCardServiceResource,
  resolveClinicCardServiceSchedule,
} from "./clinicCardServiceResourcePolicy.ts";
import { classifyClinicCardFailure } from "./clinicCardFailurePolicy.ts";
import type { ToolExecutionContext, ToolExecutor } from "../../runtime/toolExecutor.ts";
import { makeFailedToolResult } from "../../runtime/toolResults.ts";
import { getTodayInTimezone, isPastSlotTime } from "../../runtime/bookingPreflight.ts";
import { isAvailabilityDebugEnabled } from "./availabilityDiagnostics.ts";

// Parses a time string to zero-padded "HH:MM" if valid, null otherwise.
// Normalises single-digit hours: "9:00" -> "09:00".
// Rejects out-of-range values ("99:99", "24:00", "12:99") and
// natural-language strings ("afternoon", "evening") — returns null for both,
// which the caller treats as "no time filter, return all slots".
function parseHHMM(val: string | null | undefined): string | null {
  if (!val) return null;
  const m = val.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToHHMM(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function resolveEffectiveProviderWindow(input: {
  clinic_start: string;
  clinic_end: string;
  provider_start: string;
  provider_end: string;
  slot_interval_minutes: number;
}): { start: string; end: string } | null {
  const clinicStart = timeToMinutes(input.clinic_start);
  const clinicEnd = timeToMinutes(input.clinic_end);
  const providerStart = timeToMinutes(input.provider_start);
  const providerEnd = timeToMinutes(input.provider_end);
  const start = Math.max(clinicStart, providerStart);
  const end = Math.min(clinicEnd, providerEnd);
  if (end <= start) return null;

  // Preserve the clinic-confirmed start grid even when the provider begins later.
  const offset = Math.max(0, start - clinicStart);
  const alignedStart = clinicStart
    + Math.ceil(offset / input.slot_interval_minutes) * input.slot_interval_minutes;
  if (alignedStart >= end) return null;
  return { start: minutesToHHMM(alignedStart), end: minutesToHHMM(end) };
}

function emptyAvailabilityResult(
  timezone: string,
  requestedTime: string | null,
) {
  return {
    tool: "availability.check" as const,
    status: "success" as const,
    data: {
      slots: [],
      timezone,
      total_slots: 0,
      free_slots_count: 0,
      ...(requestedTime !== null ? {
        requested_time: requestedTime,
        requested_time_available: false,
        requested_time_status: "unavailable" as const,
      } : {}),
    },
  };
}

export interface ClinicCardAvailabilityExecutorDeps {
  env?: Record<string, string | undefined>;
  adapterFactory?: (config: ClinicCardConfig) => AvailabilityAdapter;
}

export function createClinicCardAvailabilityExecutor(
  deps: ClinicCardAvailabilityExecutorDeps = {},
): ToolExecutor {
  return async (context: ToolExecutionContext) => {
    const configResult = loadClinicCardConfig(deps.env);
    if (!configResult.ok) {
      return makeFailedToolResult(
        "availability.check",
        configResult.error.code,
        configResult.error.message,
        false,
      );
    }

    const config = configResult.data;

    const requestedDate = context.requested_date;
    if (!requestedDate) {
      return makeFailedToolResult(
        "availability.check",
        "availability_missing_requested_date",
        "requested_date is required",
        false,
      );
    }

    const timezone = config.timezone || context.timezone || "Europe/Prague";
    // requested_time is an anchor, not a one-slot query. A single availability read
    // answers whether the anchor itself is free and also returns nearby future options.
    const requestedTime = parseHHMM(context.requested_time);

    // Calendar truth is global and must be resolved before service routing. A malformed
    // date is a date error, and a globally closed/non-working day is authoritative
    // negative availability without requiring a service mapping unless the caller asks
    // us to auto-extend to another working day.
    if (getIsoWeekday(requestedDate) === null) {
      return makeFailedToolResult(
        "availability.check",
        "availability_invalid_requested_date",
        "requested_date must be a valid YYYY-MM-DD clinic date",
        false,
      );
    }

    // Reject past dates — ClinicCard returns slots for any date, including past ones.
    // Only enforced when context.now is present (always set in production).
    if (context.now) {
      const today = getTodayInTimezone(context.now, timezone);
      if (requestedDate < today) {
        return makeFailedToolResult(
          "availability.check",
          "availability_past_date",
          `${requestedDate} is in the past. Today is ${today}. Ask the patient for a date from today onwards.`,
          false,
        );
      }
    }

    const availabilityPolicyResult = loadClinicCardAvailabilityPolicy(deps.env);
    if (!availabilityPolicyResult.ok) {
      return makeFailedToolResult(
        "availability.check",
        availabilityPolicyResult.error.code,
        availabilityPolicyResult.error.message,
        false,
      );
    }
    const availabilityPolicy = availabilityPolicyResult.data;
    const requestedDateInsideClinicSchedule = isDateInsideAvailabilityPolicy(
      requestedDate,
      availabilityPolicy,
    );

    // A specific requested time on a clinic-closed day is authoritatively unavailable.
    // When no specific time was requested we keep going so Runtime can search the next
    // provider-authorized working day rather than asking the model to iterate dates.
    if (!requestedDateInsideClinicSchedule && requestedTime !== null) {
      return emptyAvailabilityResult(timezone, requestedTime);
    }

    // PF-011: positive/open-day availability must be tied to the authoritative
    // provider, resource and duration of a concrete service. Global doctor/cabinet
    // defaults are not write or availability authority.
    const serviceResource = resolveClinicCardServiceResource(deps.env, context.service_interest);
    if (!serviceResource.ok) {
      return makeFailedToolResult(
        "availability.check",
        serviceResource.failure === "service_missing"
          ? "availability_service_required"
          : "cliniccard_service_resource_unavailable",
        serviceResource.reason,
        false,
      );
    }
    const doctorId = serviceResource.doctor_id;
    const cabinetId = serviceResource.cabinet_id;

    // PF-013: "no visit" proves only that a resource is not already occupied. It does
    // not prove the concrete provider is working. Positive availability therefore also
    // requires an operator-confirmed schedule on the resolved service/provider rule.
    const serviceSchedule = resolveClinicCardServiceSchedule(deps.env, context.service_interest);
    if (!serviceSchedule.ok) {
      return makeFailedToolResult(
        "availability.check",
        "cliniccard_service_schedule_unavailable",
        serviceSchedule.reason,
        false,
      );
    }
    const requestedDateInsideProviderSchedule = isDateInsideClinicCardServiceSchedule(
      requestedDate,
      serviceSchedule.schedule,
    );
    if (!requestedDateInsideProviderSchedule && requestedTime !== null) {
      return emptyAvailabilityResult(timezone, requestedTime);
    }

    const effectiveWindow = resolveEffectiveProviderWindow({
      clinic_start: availabilityPolicy.working_hours_start,
      clinic_end: availabilityPolicy.working_hours_end,
      provider_start: serviceSchedule.schedule.working_hours_start,
      provider_end: serviceSchedule.schedule.working_hours_end,
      slot_interval_minutes: availabilityPolicy.slot_duration_minutes,
    });
    if (!effectiveWindow) {
      return emptyAvailabilityResult(timezone, requestedTime);
    }

    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);
    const debugEnabled = isAvailabilityDebugEnabled(deps.env);

    const scanForwardForNearestAvailable = async () => {
      for (let i = 1; i <= 7; i++) {
        const nextD = new Date(requestedDate + "T12:00:00Z");
        nextD.setUTCDate(nextD.getUTCDate() + i);
        const nextDate = nextD.toISOString().slice(0, 10);

        if (getIsoWeekday(nextDate) === null) continue;
        if (!isDateInsideAvailabilityPolicy(nextDate, availabilityPolicy)) continue;
        if (!isDateInsideClinicCardServiceSchedule(nextDate, serviceSchedule.schedule)) continue;

        const nextResult = await checkClinicCardAvailability(
          {
            date: nextDate,
            working_hours_start: effectiveWindow.start,
            working_hours_end: effectiveWindow.end,
            slot_duration_minutes: availabilityPolicy.slot_duration_minutes,
            slot_interval_minutes: availabilityPolicy.slot_duration_minutes,
            appointment_duration_minutes: serviceResource.duration_minutes,
            doctor_id: doctorId,
            cabinet_id: cabinetId,
            timezone,
          },
          adapter,
        );

        if (!nextResult.ok) {
          const disposition = classifyClinicCardFailure(nextResult.error, "read");
          return makeFailedToolResult(
            "availability.check",
            nextResult.error.code,
            nextResult.error.message,
            disposition.safe_to_retry,
          );
        }

        let nextSlots = nextResult.data.slots;
        if (context.now && nextDate === getTodayInTimezone(context.now, timezone)) {
          nextSlots = nextSlots.filter((s) => !isPastSlotTime(s.time_start, context.now!, timezone));
        }
        if (nextSlots.length === 0) continue;

        const nextMapped = nextSlots.map((s) => ({
          slot_id: `${s.date}T${s.time_start}`,
          starts_at: `${s.date}T${s.time_start}:00`,
          ends_at: `${s.date}T${s.time_end}:00`,
        }));
        const limit = context.limit;
        const nextLimited = limit !== undefined && limit > 0 ? nextMapped.slice(0, limit) : nextMapped;

        return {
          tool: "availability.check" as const,
          status: "success" as const,
          data: {
            slots: nextLimited,
            timezone,
            nearest_available_date: nextDate,
            total_slots: nextResult.data.total_slots,
            free_slots_count: nextResult.data.free_slots_count,
          },
        };
      }
      return null;
    };

    // Closed clinic/provider days are authoritative negatives for the requested date,
    // but when the patient asked for a date (not a specific hour) Runtime owns the
    // deterministic search for the next working day.
    if (!requestedDateInsideClinicSchedule || !requestedDateInsideProviderSchedule) {
      const nearest = await scanForwardForNearestAvailable();
      return nearest ?? emptyAvailabilityResult(timezone, requestedTime);
    }

    const result = await checkClinicCardAvailability(
      {
        date: requestedDate,
        working_hours_start: effectiveWindow.start,
        working_hours_end: effectiveWindow.end,
        // PF-011 separates when a visit may start from how long this service occupies
        // the doctor/cabinet. The static policy owns the start cadence; the service rule
        // owns visit duration.
        slot_duration_minutes: availabilityPolicy.slot_duration_minutes,
        slot_interval_minutes: availabilityPolicy.slot_duration_minutes,
        appointment_duration_minutes: serviceResource.duration_minutes,
        doctor_id: doctorId,
        cabinet_id: cabinetId,
        timezone,
        debug: debugEnabled,
      },
      adapter,
    );

    if (!result.ok) {
      const disposition = classifyClinicCardFailure(result.error, "read");
      return makeFailedToolResult(
        "availability.check",
        result.error.code,
        result.error.message,
        disposition.safe_to_retry,
      );
    }

    // total_slots and free_slots_count always reflect the full provider-authorized
    // working window — before any requested-time filtering.
    const total_slots = result.data.total_slots;
    const free_slots_count = result.data.free_slots_count;

    // requested_time is an anchor: keep the requested slot if free and include the
    // next free slots in the same result. The model must not need another lookup merely
    // because the exact anchor is occupied.
    let freeSlots = result.data.slots;
    if (requestedTime !== null) {
      freeSlots = freeSlots.filter((s) => s.time_start >= requestedTime);
    }
    const countAfterTimeFilter = freeSlots.length;

    // Filter out past slots when the requested date is today in the clinic timezone.
    // This prevents the bot from offering times that have already passed.
    if (context.now && requestedDate === getTodayInTimezone(context.now, timezone)) {
      freeSlots = freeSlots.filter((s) => !isPastSlotTime(s.time_start, context.now!, timezone));
    }
    const countAfterPastFilter = freeSlots.length;
    const requestedTimeAvailable = requestedTime !== null
      ? freeSlots.some((s) => s.time_start === requestedTime)
      : null;

    // Map to output format.
    const mappedSlots = freeSlots.map((s) => ({
      slot_id: `${s.date}T${s.time_start}`,
      starts_at: `${s.date}T${s.time_start}:00`,
      ends_at: `${s.date}T${s.time_end}:00`,
    }));

    // Cap to limit if provided.
    const limit = context.limit;
    const limitedSlots = limit !== undefined && limit > 0 ? mappedSlots.slice(0, limit) : mappedSlots;

    if (limitedSlots.length === 0 && requestedTime === null) {
      const nearest = await scanForwardForNearestAvailable();
      if (nearest !== null) return nearest;
    }

    // Patch post-filter counts into diagnostic if it was collected.
    const diagnostic = result.data.diagnostic
      ? {
          ...result.data.diagnostic,
          free_slots_count_after_requested_time_filter: countAfterTimeFilter,
          free_slots_count_after_past_time_filter: countAfterPastFilter,
          limited_slots_count: limitedSlots.length,
        }
      : undefined;

    return {
      tool: "availability.check",
      status: "success",
      data: {
        slots: limitedSlots,
        timezone,
        total_slots,
        free_slots_count,
        ...(requestedTime !== null ? {
          requested_time: requestedTime,
          requested_time_available: requestedTimeAvailable,
          requested_time_status: requestedTimeAvailable ? "available" : "unavailable",
        } : {}),
      },
      ...(diagnostic !== undefined ? { _diagnostic: diagnostic } : {}),
    };
  };
}

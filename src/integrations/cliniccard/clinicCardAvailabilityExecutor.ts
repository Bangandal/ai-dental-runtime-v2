import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import { checkClinicCardAvailability, type AvailabilityAdapter } from "./clinicCardAvailability.ts";
import { getIsoWeekday, isDateInsideAvailabilityPolicy, loadClinicCardAvailabilityPolicy } from "./clinicCardAvailabilityPolicy.ts";
import { resolveClinicCardServiceResource } from "./clinicCardServiceResourcePolicy.ts";
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
    // negative availability without requiring a service mapping.
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

    // A configured non-working/closed date is authoritative negative evidence.
    // No service mapping or ClinicCard visit read is needed because the schedule policy
    // proves the clinic cannot offer any service slot on that date.
    if (!isDateInsideAvailabilityPolicy(requestedDate, availabilityPolicy)) {
      return {
        tool: "availability.check",
        status: "success",
        data: {
          slots: [],
          timezone,
          total_slots: 0,
          free_slots_count: 0,
          ...(requestedTime !== null ? {
            requested_time: requestedTime,
            requested_time_available: false,
            requested_time_status: "unavailable",
          } : {}),
        },
      };
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

    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    const debugEnabled = isAvailabilityDebugEnabled(deps.env);

    const result = await checkClinicCardAvailability(
      {
        date: requestedDate,
        working_hours_start: availabilityPolicy.working_hours_start,
        working_hours_end: availabilityPolicy.working_hours_end,
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

    // total_slots and free_slots_count always reflect the full day — before any filtering.
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

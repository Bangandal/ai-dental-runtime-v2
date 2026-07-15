import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import { checkClinicCardAvailability, type AvailabilityAdapter } from "./clinicCardAvailability.ts";
import type { ToolExecutionContext, ToolExecutor } from "../../runtime/toolExecutor.ts";
import { makeFailedToolResult } from "../../runtime/toolResults.ts";
import { getTodayInTimezone, isPastSlotTime } from "../../runtime/bookingPreflight.ts";
import { isAvailabilityDebugEnabled } from "./availabilityDiagnostics.ts";

const DEFAULT_WORKING_HOURS_START = "09:00";
const DEFAULT_WORKING_HOURS_END = "18:00";
const DEFAULT_SLOT_DURATION_MINUTES = 30;

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

    const doctorId = Number(config.default_doctor_id);
    if (!Number.isFinite(doctorId) || !Number.isInteger(doctorId) || doctorId <= 0) {
      return makeFailedToolResult(
        "availability.check",
        "cliniccard_config_invalid_doctor_id",
        "CLINICCARD_DEFAULT_DOCTOR_ID must be a positive integer",
        false,
      );
    }

    const cabinetId = Number(config.default_cabinet_id);
    if (!Number.isFinite(cabinetId) || !Number.isInteger(cabinetId) || cabinetId <= 0) {
      return makeFailedToolResult(
        "availability.check",
        "cliniccard_config_invalid_cabinet_id",
        "CLINICCARD_DEFAULT_CABINET_ID must be a positive integer",
        false,
      );
    }

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

    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    const debugEnabled = isAvailabilityDebugEnabled(deps.env);

    const result = await checkClinicCardAvailability(
      {
        date: requestedDate,
        working_hours_start: DEFAULT_WORKING_HOURS_START,
        working_hours_end: DEFAULT_WORKING_HOURS_END,
        slot_duration_minutes: DEFAULT_SLOT_DURATION_MINUTES,
        doctor_id: doctorId,
        cabinet_id: cabinetId,
        timezone,
        debug: debugEnabled,
      },
      adapter,
    );

    if (!result.ok) {
      return makeFailedToolResult(
        "availability.check",
        result.error.code,
        result.error.message,
        false,
      );
    }

    // total_slots and free_slots_count always reflect the full day — before any filtering.
    const total_slots = result.data.total_slots;
    const free_slots_count = result.data.free_slots_count;

    // Filter free slots to at/after requested_time if it is a parseable HH:MM value.
    const requestedTime = parseHHMM(context.requested_time);
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
      },
      ...(diagnostic !== undefined ? { _diagnostic: diagnostic } : {}),
    };
  };
}

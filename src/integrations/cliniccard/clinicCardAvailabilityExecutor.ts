import type { ClinicCardConfig } from "./clinicCardTypes.ts";
import { loadClinicCardConfig } from "./clinicCardConfig.ts";
import { createClinicCardAdapter } from "./clinicCardAdapter.ts";
import { checkClinicCardAvailability, type AvailabilityAdapter } from "./clinicCardAvailability.ts";
import type { ToolExecutionContext, ToolExecutor } from "../../runtime/toolExecutor.ts";
import { makeFailedToolResult } from "../../runtime/toolResults.ts";

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
    const adapterFactory = deps.adapterFactory ?? ((cfg: ClinicCardConfig) => createClinicCardAdapter(cfg));
    const adapter = adapterFactory(config);

    const result = await checkClinicCardAvailability(
      {
        date: requestedDate,
        working_hours_start: "09:00",
        working_hours_end: "18:00",
        slot_duration_minutes: 30,
        doctor_id: doctorId,
        cabinet_id: cabinetId,
        timezone,
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

    return {
      tool: "availability.check",
      status: "success",
      data: {
        slots: result.data.slots.map((s) => ({
          slot_id: `${s.date}T${s.time_start}`,
          starts_at: `${s.date}T${s.time_start}:00`,
          ends_at: `${s.date}T${s.time_end}:00`,
        })),
        timezone,
        total_slots: result.data.total_slots,
        free_slots_count: result.data.free_slots_count,
      },
    };
  };
}

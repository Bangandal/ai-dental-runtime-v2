import type { ClinicCardBookingMode, ClinicCardConfig, ClinicCardResult } from "./clinicCardTypes.ts";

const VALID_BOOKING_MODES: ReadonlySet<string> = new Set(["disabled", "shadow", "live"]);

export type ClinicCardConfigResult = ClinicCardResult<ClinicCardConfig>;

export function loadClinicCardConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ClinicCardConfigResult {
  const api_base_url = env["CLINICCARD_API_BASE_URL"]?.trim();
  const api_token = env["CLINICCARD_API_TOKEN"]?.trim();

  if (!api_base_url) {
    return {
      ok: false,
      error: {
        code: "cliniccard_config_missing_field",
        message: "CLINICCARD_API_BASE_URL is required but not set",
      },
    };
  }

  if (!api_token) {
    return {
      ok: false,
      error: {
        code: "cliniccard_config_missing_field",
        message: "CLINICCARD_API_TOKEN is required but not set",
      },
    };
  }

  const mode_raw = env["CLINICCARD_BOOKING_MODE"]?.trim() ?? "disabled";
  if (!VALID_BOOKING_MODES.has(mode_raw)) {
    return {
      ok: false,
      error: {
        code: "cliniccard_config_invalid_booking_mode",
        message: `CLINICCARD_BOOKING_MODE must be one of: disabled, shadow, live`,
      },
    };
  }

  return {
    ok: true,
    data: {
      api_base_url,
      api_token,
      default_doctor_id: env["CLINICCARD_DEFAULT_DOCTOR_ID"]?.trim() ?? "",
      default_cabinet_id: env["CLINICCARD_DEFAULT_CABINET_ID"]?.trim() ?? "",
      timezone: env["CLINICCARD_TIMEZONE"]?.trim() ?? "Europe/Prague",
      booking_mode: mode_raw as ClinicCardBookingMode,
    },
  };
}

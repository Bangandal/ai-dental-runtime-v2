import type { ClinicCardConfig, ClinicCardPatient, ClinicCardResult, ClinicCardVisit } from "./clinicCardTypes.ts";
import type { ClinicCardConfigResult } from "./clinicCardConfig.ts";

export interface ClinicCardProbeInput {
  phone?: string;
  from?: string;
  to?: string;
}

export interface ClinicCardProbeOutput {
  config_loaded: boolean;
  api_ok: boolean;
  patients_found_count: number;
  visits_found_count: number;
  error?: string;
}

// Minimal read-only surface exposed to the probe — no write methods.
export interface ReadOnlyClinicCardAdapter {
  findPatientByPhone(phone: string): Promise<ClinicCardResult<ClinicCardPatient[]>>;
  listVisits(from: string, to: string): Promise<ClinicCardResult<ClinicCardVisit[]>>;
}

export interface ClinicCardProbeDeps {
  loadConfig(): ClinicCardConfigResult;
  createAdapter(config: ClinicCardConfig): ReadOnlyClinicCardAdapter;
}

// Replace the phone string with a masked version in error messages so
// patient phone numbers do not appear in probe output or logs.
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "***";
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

function redactPhone(text: string, phone: string): string {
  return text.split(phone).join(maskPhone(phone));
}

export async function runClinicCardProbe(
  input: ClinicCardProbeInput,
  deps: ClinicCardProbeDeps,
): Promise<ClinicCardProbeOutput> {
  const configResult = deps.loadConfig();

  if (!configResult.ok) {
    return {
      config_loaded: false,
      api_ok: false,
      patients_found_count: 0,
      visits_found_count: 0,
      error: configResult.error.message,
    };
  }

  const adapter = deps.createAdapter(configResult.data);
  let patients_found_count = 0;
  let visits_found_count = 0;
  let api_ok = true;
  let error: string | undefined;

  if (input.phone) {
    const result = await adapter.findPatientByPhone(input.phone);
    if (result.ok) {
      patients_found_count = result.data.length;
    } else {
      api_ok = false;
      // Mask phone and ensure token is not present (adapter already redacts token).
      error = redactPhone(result.error.message, input.phone);
    }
  }

  if (input.from && input.to) {
    const result = await adapter.listVisits(input.from, input.to);
    if (result.ok) {
      visits_found_count = result.data.length;
    } else {
      api_ok = false;
      const msg = input.phone
        ? redactPhone(result.error.message, input.phone)
        : result.error.message;
      error = error ?? msg;
    }
  }

  return {
    config_loaded: true,
    api_ok,
    patients_found_count,
    visits_found_count,
    error,
  };
}

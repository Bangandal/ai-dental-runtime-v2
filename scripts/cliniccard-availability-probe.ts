import { fileURLToPath } from "node:url";
import { loadClinicCardConfig } from "../src/integrations/cliniccard/clinicCardConfig.ts";
import { createClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import { checkClinicCardAvailability } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { AvailabilityInput, AvailabilitySlot } from "../src/integrations/cliniccard/clinicCardAvailability.ts";
import type { ClinicCardConfig } from "../src/integrations/cliniccard/clinicCardTypes.ts";
import type { ClinicCardConfigResult } from "../src/integrations/cliniccard/clinicCardConfig.ts";

export interface AvailabilityProbeArgs {
  date?: string;
  date_to?: string;
  doctor_id?: number;
  cabinet_id?: number;
  working_hours_start?: string;
  working_hours_end?: string;
  duration_minutes?: number;
  timezone?: string;
}

export interface AvailabilityProbeOutput {
  config_loaded: boolean;
  api_ok: boolean;
  availability_ok: boolean;
  total_slots: number;
  free_slots_count: number;
  sample_slots: AvailabilitySlot[];
  error: string | null;
}

export interface AvailabilityProbeDeps {
  loadConfig(): ClinicCardConfigResult;
  createAdapter(config: ClinicCardConfig): { listVisits(from: string, to: string): Promise<import("../src/integrations/cliniccard/clinicCardTypes.ts").ClinicCardResult<import("../src/integrations/cliniccard/clinicCardTypes.ts").ClinicCardVisit[]>> };
}

const DEFAULT_DEPS: AvailabilityProbeDeps = {
  loadConfig: loadClinicCardConfig,
  createAdapter: createClinicCardAdapter,
};

// Strict positive integer: rejects "10abc", "2x", "30.5", "30min", 0, negatives.
// parseInt silently truncates trailing chars — Number() is exact.
function parseStrictPositiveInt(val: string): number | undefined {
  const n = Number(val);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

export function parseAvailabilityArgs(argv: string[]): AvailabilityProbeArgs {
  const result: AvailabilityProbeArgs = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    const key = arg.slice(2, eq);
    const val = arg.slice(eq + 1);
    if (!val) continue;
    switch (key) {
      case "date": result.date = val; break;
      case "date-to": result.date_to = val; break;
      case "doctor-id": result.doctor_id = parseStrictPositiveInt(val); break;
      case "cabinet-id": result.cabinet_id = parseStrictPositiveInt(val); break;
      case "working-hours-start": result.working_hours_start = val; break;
      case "working-hours-end": result.working_hours_end = val; break;
      case "duration-minutes": result.duration_minutes = parseStrictPositiveInt(val); break;
      case "timezone": result.timezone = val; break;
    }
  }
  return result;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((a) => a.startsWith(`--${flag}=`));
}

function failClosed(
  error: string,
  config_loaded: boolean,
  writeLine: (text: string) => void,
): { output: AvailabilityProbeOutput; exitCode: number } {
  const output: AvailabilityProbeOutput = {
    config_loaded,
    api_ok: false,
    availability_ok: false,
    total_slots: 0,
    free_slots_count: 0,
    sample_slots: [],
    error,
  };
  writeLine(JSON.stringify(output, null, 2));
  return { output, exitCode: 1 };
}

export async function runAvailabilityProbeRunner(
  argv: string[],
  deps: AvailabilityProbeDeps = DEFAULT_DEPS,
  writeLine: (text: string) => void = console.log,
): Promise<{ output: AvailabilityProbeOutput; exitCode: number }> {
  const args = parseAvailabilityArgs(argv);

  // Detect invalid (present but rejected) numeric args before loading config —
  // fail closed immediately without any API call.
  if (hasFlag(argv, "doctor-id") && args.doctor_id === undefined) {
    return failClosed("invalid_numeric_argument: --doctor-id must be a positive integer", false, writeLine);
  }
  if (hasFlag(argv, "cabinet-id") && args.cabinet_id === undefined) {
    return failClosed("invalid_numeric_argument: --cabinet-id must be a positive integer", false, writeLine);
  }
  if (hasFlag(argv, "duration-minutes") && args.duration_minutes === undefined) {
    return failClosed("invalid_numeric_argument: --duration-minutes must be a positive integer", false, writeLine);
  }

  const configResult = deps.loadConfig();
  if (!configResult.ok) {
    return failClosed(configResult.error.message, false, writeLine);
  }

  // Validate required args — fail closed on missing inputs
  if (!args.date) {
    return failClosed("--date is required", true, writeLine);
  }

  if (args.doctor_id === undefined) {
    return failClosed("--doctor-id is required", true, writeLine);
  }

  if (args.cabinet_id === undefined) {
    return failClosed("--cabinet-id is required", true, writeLine);
  }

  const duration = args.duration_minutes ?? 30;
  const input: AvailabilityInput = {
    date: args.date,
    date_to: args.date_to,
    working_hours_start: args.working_hours_start ?? "09:00",
    working_hours_end: args.working_hours_end ?? "18:00",
    slot_duration_minutes: duration,
    doctor_id: args.doctor_id,
    cabinet_id: args.cabinet_id,
    timezone: args.timezone ?? "Europe/Prague",
  };

  let output: AvailabilityProbeOutput;

  try {
    const adapter = deps.createAdapter(configResult.data);
    const result = await checkClinicCardAvailability(input, adapter);

    if (!result.ok) {
      output = {
        config_loaded: true,
        api_ok: false,
        availability_ok: false,
        total_slots: 0,
        free_slots_count: 0,
        sample_slots: [],
        error: result.error.message,
      };
    } else {
      output = {
        config_loaded: true,
        api_ok: true,
        availability_ok: true,
        total_slots: result.data.total_slots,
        free_slots_count: result.data.free_slots_count,
        // Only first 5 slots — no patient data, only date/time fields
        sample_slots: result.data.slots.slice(0, 5),
        error: null,
      };
    }
  } catch {
    // Never expose thrown error details — may contain sensitive data.
    output = {
      config_loaded: true,
      api_ok: false,
      availability_ok: false,
      total_slots: 0,
      free_slots_count: 0,
      sample_slots: [],
      error: "availability_probe_unexpected_error",
    };
  }

  // Sanitized output only — no patient names, no raw phone, no token, no raw visits.
  const sanitized: AvailabilityProbeOutput = {
    config_loaded: output.config_loaded,
    api_ok: output.api_ok,
    availability_ok: output.availability_ok,
    total_slots: output.total_slots,
    free_slots_count: output.free_slots_count,
    sample_slots: output.sample_slots,
    error: output.error,
  };

  writeLine(JSON.stringify(sanitized, null, 2));
  const exitCode = sanitized.config_loaded && sanitized.api_ok && sanitized.availability_ok ? 0 : 1;
  return { output: sanitized, exitCode };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runAvailabilityProbeRunner(process.argv.slice(2)).then(({ exitCode }) => {
    process.exit(exitCode);
  }).catch(() => {
    console.log(JSON.stringify({ ok: false, error: "unexpected_runner_error" }));
    process.exit(1);
  });
}

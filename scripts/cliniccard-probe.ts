import { fileURLToPath } from "node:url";
import { loadClinicCardConfig } from "../src/integrations/cliniccard/clinicCardConfig.ts";
import { createClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import {
  runClinicCardProbe,
  type ClinicCardProbeDeps,
  type ClinicCardProbeOutput,
} from "../src/integrations/cliniccard/clinicCardProbe.ts";

export interface ProbeRunnerArgs {
  phone?: string;
  from?: string;
  to?: string;
}

export function parseCliArgs(argv: string[]): ProbeRunnerArgs {
  const result: ProbeRunnerArgs = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eqIndex = arg.indexOf("=");
    if (eqIndex === -1) continue;
    const key = arg.slice(2, eqIndex);
    const value = arg.slice(eqIndex + 1);
    if (key === "phone" && value) result.phone = value;
    if (key === "from" && value) result.from = value;
    if (key === "to" && value) result.to = value;
  }
  return result;
}

const DEFAULT_DEPS: ClinicCardProbeDeps = {
  loadConfig: loadClinicCardConfig,
  createAdapter: createClinicCardAdapter,
};

// writeLine is injectable so tests can capture output without mocking console.
export async function runProbeRunner(
  argv: string[],
  deps: ClinicCardProbeDeps = DEFAULT_DEPS,
  writeLine: (text: string) => void = console.log,
): Promise<{ output: ClinicCardProbeOutput; exitCode: number }> {
  const input = parseCliArgs(argv);
  let output: ClinicCardProbeOutput;

  try {
    output = await runClinicCardProbe(input, deps);
  } catch {
    // Never expose thrown error details — may contain sensitive data.
    output = {
      config_loaded: false,
      api_ok: false,
      patients_found_count: 0,
      visits_found_count: 0,
      error: "probe_runner_unexpected_error",
    };
  }

  // Print only sanitized counts and status flags — no patient names, no raw
  // phones, no token. runClinicCardProbe already masks phone in error messages.
  const sanitized: ClinicCardProbeOutput = {
    config_loaded: output.config_loaded,
    api_ok: output.api_ok,
    patients_found_count: output.patients_found_count,
    visits_found_count: output.visits_found_count,
    ...(output.error !== undefined ? { error: output.error } : {}),
  };

  writeLine(JSON.stringify(sanitized, null, 2));
  return { output: sanitized, exitCode: output.config_loaded && output.api_ok ? 0 : 1 };
}

// Entry point — only executes when this file is run directly.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runProbeRunner(process.argv.slice(2)).then(({ exitCode }) => {
    process.exit(exitCode);
  }).catch(() => {
    console.log(JSON.stringify({ ok: false, error: "unexpected_runner_error" }));
    process.exit(1);
  });
}

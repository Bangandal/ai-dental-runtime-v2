import { buildAgentFirstSystemInstruction } from "./agentFirstSystemInstruction.ts";

export const LEGACY_RUNTIME_MODEL_CALL_BUDGET = 3;
export const AGENT_FIRST_RUNTIME_MODEL_CALL_BUDGET = 6;

export type RuntimeAgentMode = "legacy" | "agent_first";

export function getRuntimeAgentMode(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): RuntimeAgentMode {
  return env.RUNTIME_AGENT_MODE === "agent_first" ? "agent_first" : "legacy";
}

export function isAgentFirstRuntimeEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return getRuntimeAgentMode(env) === "agent_first";
}

export function resolveRuntimeModelCallBudget(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  if (!isAgentFirstRuntimeEnabled(env)) return LEGACY_RUNTIME_MODEL_CALL_BUDGET;

  const configured = Number(env.RUNTIME_AGENT_MAX_MODEL_CALLS);
  if (Number.isInteger(configured) && configured >= 2 && configured <= 12) {
    return configured;
  }

  return AGENT_FIRST_RUNTIME_MODEL_CALL_BUDGET;
}

/**
 * Select the model instruction for the active Runtime mode.
 *
 * Legacy receives the historical scripted prompt unchanged.
 * Agent-first receives a standalone clean prompt. The old prompt is used only as a carrier
 * for the already-computed current-date/time line so relative-date behavior stays grounded;
 * its intake state machine and booking ceremony are not inherited by the model.
 */
export function resolveRuntimeSystemInstruction(
  legacyInstruction: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  if (!isAgentFirstRuntimeEnabled(env)) return legacyInstruction;
  return buildAgentFirstSystemInstruction(legacyInstruction);
}

/**
 * Compatibility export for tests/older imports. Agent-first no longer appends an override;
 * it replaces the legacy instruction with the clean upper-layer instruction.
 */
export function appendAgentFirstSystemInstruction(baseInstruction: string): string {
  return resolveRuntimeSystemInstruction(baseInstruction);
}

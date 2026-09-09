import { buildAgentFirstSystemInstruction } from "./agentFirstSystemInstruction.ts";

export const RUNTIME_MODEL_CALL_BUDGET = 6;

/**
 * Runtime is agent-first only. This predicate remains as a semantic capability helper
 * while lower-level modules are being simplified; there is no legacy mode or rollback path.
 */
export function isAgentFirstRuntimeEnabled(): true {
  return true;
}

export function resolveRuntimeModelCallBudget(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const configured = Number(env.RUNTIME_AGENT_MAX_MODEL_CALLS);
  if (Number.isInteger(configured) && configured >= 2 && configured <= 12) {
    return configured;
  }
  return RUNTIME_MODEL_CALL_BUDGET;
}

/** The clean agent-first instruction is the only patient-facing Runtime instruction. */
export function resolveRuntimeSystemInstruction(baseInstruction: string): string {
  return buildAgentFirstSystemInstruction(baseInstruction);
}

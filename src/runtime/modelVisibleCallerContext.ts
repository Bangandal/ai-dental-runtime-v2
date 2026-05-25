import type { RuntimeAgentTurnInput } from "./openaiRuntimeAgent.ts";

export function buildModelVisibleCallerContext(input: RuntimeAgentTurnInput): Record<string, unknown> {
  const runtimeContext = (input.business_context?.runtime_context as Record<string, unknown> | undefined) ?? null;
  const runtimePolicy = runtimeContext && typeof runtimeContext.runtime_policy === "object"
    ? (runtimeContext.runtime_policy as Record<string, unknown>)
    : null;

  return {
    locale: input.locale ?? null,
    channel_context: {
      channel: input.business_context?.channel ?? null,
      patient_reachable_in_current_channel: Boolean(runtimePolicy?.patient_reachable_in_current_channel),
    },
    runtime_context: runtimeContext,
    truth_snapshot: input.truth_snapshot ?? null,
    recent_summary: input.recent_summary ?? null,
  };
}

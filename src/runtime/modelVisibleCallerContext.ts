import type { RuntimeAgentTurnInput } from "./openaiRuntimeAgent.ts";
import { buildModelVisiblePeopleContext } from "./modelPeopleContextBridge.ts";

export function buildModelVisibleCallerContext(input: RuntimeAgentTurnInput): Record<string, unknown> {
  const runtimeContext = (input.business_context?.runtime_context as Record<string, unknown> | undefined) ?? null;
  const runtimePolicy = runtimeContext && typeof runtimeContext.runtime_policy === "object"
    ? (runtimeContext.runtime_policy as Record<string, unknown>)
    : null;

  const effectiveRuntimeContext: Record<string, unknown> | null = runtimeContext
    ? { ...runtimeContext }
    : input.booking_subjects
      ? {}
      : null;

  if (effectiveRuntimeContext && input.booking_subjects) {
    effectiveRuntimeContext.booking_subjects = buildModelVisiblePeopleContext(input.booking_subjects);
  }

  return {
    locale: input.locale ?? null,
    channel_context: {
      channel: input.business_context?.channel ?? null,
      patient_reachable_in_current_channel: Boolean(runtimePolicy?.patient_reachable_in_current_channel),
    },
    runtime_context: effectiveRuntimeContext,
    truth_snapshot: input.truth_snapshot ?? null,
    recent_summary: input.recent_summary ?? null,
  };
}

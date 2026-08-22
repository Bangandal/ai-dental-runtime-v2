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

export interface RuntimeModelContextFacts {
  booking_process_state?: unknown;
  booking_apply_action_truth?: unknown | null;
  availability_action_truth?: unknown | null;
  availability_presentation_truth?: unknown | null;
  appointment_display_truth?: unknown | null;
  resolved_context?: unknown;
}

/**
 * Compose the model-visible context for any runtime model call.
 *
 * The base caller context owns stable turn/channel/people facts. This function owns the
 * optional runtime facts added after deterministic work. Null action/presentation truths
 * are deliberately omitted, matching the historical spread behavior in the legacy loop.
 * `resolved_context` is included whenever the caller explicitly supplies it, including an
 * empty array, because its presence is a protocol decision rather than a truthy-data test.
 */
export function composeRuntimeModelContext(
  baseContext: Record<string, unknown>,
  facts: RuntimeModelContextFacts = {},
): Record<string, unknown> {
  return {
    ...baseContext,
    ...(facts.booking_process_state !== undefined
      ? { booking_process_state: facts.booking_process_state }
      : {}),
    ...(facts.booking_apply_action_truth != null
      ? { booking_apply_action_truth: facts.booking_apply_action_truth }
      : {}),
    ...(facts.availability_action_truth != null
      ? { availability_action_truth: facts.availability_action_truth }
      : {}),
    ...(facts.availability_presentation_truth != null
      ? { availability_presentation_truth: facts.availability_presentation_truth }
      : {}),
    ...(facts.appointment_display_truth != null
      ? { appointment_display_truth: facts.appointment_display_truth }
      : {}),
    ...(facts.resolved_context !== undefined
      ? { resolved_context: facts.resolved_context }
      : {}),
  };
}

import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import { buildBookingApplyActionTruth } from "./bookingApplyGuard.ts";
import {
  buildAvailabilityActionTruth,
  resolveAuthoritativeAvailabilityAttempt,
} from "./availabilityActionTruth.ts";
import {
  buildAvailabilityPresentationTruth,
  type AvailabilityPresentationTruth,
} from "./availabilityPresentationTruth.ts";
import { buildAppointmentDisplayTruth } from "./appointmentDisplayTruth.ts";
import {
  buildModelVisibleBookingProcessState,
  hasMeaningfulBookingState,
  type BookingProcessState,
  type ModelVisibleBookingProcessState,
} from "./bookingProcessState.ts";
import { composeRuntimeModelContext } from "./modelVisibleCallerContext.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";

export interface RuntimeTurnModelProjection {
  context: Record<string, unknown>;
  visible_booking_process_state: ModelVisibleBookingProcessState;
  booking_apply_action_truth: ReturnType<typeof buildBookingApplyActionTruth>;
  availability_action_truth: ReturnType<typeof buildAvailabilityActionTruth>;
  availability_presentation_truth: ReturnType<typeof buildAvailabilityPresentationTruth>;
  appointment_display_truth: ReturnType<typeof buildAppointmentDisplayTruth>;
}

/**
 * Agent-first keeps persisted availability evidence for deterministic booking proof, but that
 * evidence is not presentation authority on a later patient turn. Only an authoritative
 * availability.check from the current turn may expose a list of slots as currently available.
 *
 * Keep selected_slot/proof untouched: a patient may choose a previously offered exact slot and
 * Runtime still needs to validate that choice against persisted evidence before booking.apply.
 */
export function enforceCurrentTurnAvailabilityPresentationBoundary(params: {
  state: ModelVisibleBookingProcessState;
  current_turn_truth: AvailabilityPresentationTruth | null;
  require_current_turn_truth: boolean;
}): ModelVisibleBookingProcessState {
  if (!params.require_current_turn_truth || params.current_turn_truth !== null) {
    return params.state;
  }

  return {
    ...params.state,
    last_available_slots: [],
    next_action:
      params.state.next_action === "choose_from_available_slots"
        ? undefined
        : params.state.next_action,
  };
}

/**
 * Project authoritative runtime state into the model-visible context for any model call.
 *
 * Model-call number is intentionally absent. The same accumulated requests/results/state
 * produce the same projection whether they were reached after the first or a later batch.
 */
export function buildRuntimeTurnModelProjection(params: {
  caller_context: Record<string, unknown>;
  prior_booking_process_state: Partial<BookingProcessState> | null;
  booking_process_state: BookingProcessState;
  processed_tool_requests: RuntimeAgentToolRequest[];
  tool_results: RuntimeAgentToolResult[];
  now: Date;
  timezone: string;
}): RuntimeTurnModelProjection {
  const bookingApplyTruth = buildBookingApplyActionTruth(params.tool_results);
  const availabilityAttempt = resolveAuthoritativeAvailabilityAttempt(
    params.processed_tool_requests,
    params.tool_results,
  );
  const availabilityActionTruth = buildAvailabilityActionTruth(availabilityAttempt);
  const availabilityPresentationTruth = buildAvailabilityPresentationTruth(availabilityAttempt);
  const appointmentDisplayTruth = buildAppointmentDisplayTruth(params.tool_results);

  const hasBookingToolResult = params.tool_results.some(
    (result) => result.tool === "availability.check" ||
      result.tool === "booking.apply" ||
      result.tool === "booking.select_slot",
  );
  const bookingStateGrounded =
    (params.prior_booking_process_state !== null && hasMeaningfulBookingState(params.prior_booking_process_state)) ||
    hasBookingToolResult ||
    params.booking_process_state.selected_slot != null;

  const baseVisibleBookingState = buildModelVisibleBookingProcessState({
    state: params.booking_process_state,
    priorProcessState: params.prior_booking_process_state,
    bookingStateGrounded,
    now: params.now,
    timezone: params.timezone,
  });
  const visibleBookingState = enforceCurrentTurnAvailabilityPresentationBoundary({
    state: baseVisibleBookingState,
    current_turn_truth: availabilityPresentationTruth,
    require_current_turn_truth: isAgentFirstRuntimeEnabled(),
  });

  return {
    context: composeRuntimeModelContext(params.caller_context, {
      booking_process_state: visibleBookingState,
      booking_apply_action_truth: bookingApplyTruth,
      availability_action_truth: availabilityActionTruth,
      availability_presentation_truth: availabilityPresentationTruth,
      appointment_display_truth: appointmentDisplayTruth,
    }),
    visible_booking_process_state: visibleBookingState,
    booking_apply_action_truth: bookingApplyTruth,
    availability_action_truth: availabilityActionTruth,
    availability_presentation_truth: availabilityPresentationTruth,
    appointment_display_truth: appointmentDisplayTruth,
  };
}

import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import type { AvailabilityEvidence } from "./slotEvidence.ts";
import type { SubjectId } from "./bookingSubjectsState.ts";
import {
  executeBookingSelectSlotBatch,
  type BookingSelectSlotBatchResult,
} from "./bookingSelectSlot.ts";

export interface BookingSelectApplyBatchConflict {
  booking_apply_request: RuntimeAgentToolRequest;
  selection: BookingSelectSlotBatchResult;
  tool_results: RuntimeAgentToolResult[];
}

/**
 * Resolve the protocol conflict where one model tool batch contains both
 * booking.select_slot and booking.apply.
 *
 * booking.apply depends on the RESULT of booking.select_slot, so a request emitted beside
 * it in the same model output cannot consume the proof that selection is about to create.
 * This is a batch-content rule and deliberately knows nothing about model-call rounds.
 *
 * The returned result set is protocol-complete for the whole batch:
 * - every select_slot request receives its deterministic result;
 * - the one booking.apply request is closed with a fail-closed retry result;
 * - every other request is denied so no function call id is left open.
 *
 * Multiple booking.apply requests are expected to be intercepted by the caller's stronger
 * one-write guard before this helper is invoked.
 */
export function resolveBookingSelectApplyBatchConflict(params: {
  requests: RuntimeAgentToolRequest[];
  activeEvidence: AvailabilityEvidence | null | undefined;
  subjects?: Array<{ id: SubjectId }> | null;
}): BookingSelectApplyBatchConflict | null {
  const bookingApplyRequests = params.requests.filter((request) => request.tool === "booking.apply");
  const bookingApplyRequest = bookingApplyRequests.length === 1 ? bookingApplyRequests[0] : null;
  const selectRequests = params.requests.filter((request) => request.tool === "booking.select_slot");

  if (!bookingApplyRequest || selectRequests.length === 0) return null;

  const selection = executeBookingSelectSlotBatch({
    requests: selectRequests,
    activeEvidence: params.activeEvidence,
    subjects: params.subjects,
  });

  const toolResults: RuntimeAgentToolResult[] = [...selection.tool_results, {
    tool: "booking.apply",
    call_id: bookingApplyRequest.call_id,
    status: "success",
    data: {
      booking_status: "slot_not_verified",
      created_visit: false,
      may_claim_booked: false,
      required_next_action: "retry_booking_apply",
      // Historical model-visible reason retained while the legacy loop is still active.
      // Semantically this now means "same model tool batch", not a numbered LLM round.
      reason: "select_slot_and_booking_apply_same_round",
    },
  }];

  const handledCallIds = new Set<string | undefined>([
    ...selectRequests.map((request) => request.call_id),
    bookingApplyRequest.call_id,
  ]);

  for (const request of params.requests) {
    if (handledCallIds.has(request.call_id)) continue;
    toolResults.push({
      tool: request.tool,
      call_id: request.call_id,
      status: "denied",
      error: {
        code: "guard_s_same_round_protocol",
        message: "Tool was not executed because booking.select_slot and booking.apply were returned in the same model tool batch",
      },
    });
  }

  return {
    booking_apply_request: bookingApplyRequest,
    selection,
    tool_results: toolResults,
  };
}

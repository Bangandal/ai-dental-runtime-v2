import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
} from "./openaiRuntimeAgent.ts";
import type { AvailabilityEvidence } from "./slotEvidence.ts";
import type { SubjectId } from "./bookingSubjectsState.ts";
import {
  executeBookingSelectSlot,
  type BookingSelectSlotSuccessData,
} from "./bookingSelectSlot.ts";

export interface BookingSlotSelectionBatchResult {
  attempted: boolean;
  success_data: BookingSelectSlotSuccessData | null;
  tool_results: RuntimeAgentToolResult[];
}

/**
 * Deterministically resolves booking.select_slot requests for one model tool batch.
 *
 * Business legality depends only on explicit selection + active availability evidence.
 * The caller decides where in the model-call lifecycle this batch occurred; round number
 * is intentionally absent from this contract.
 *
 * Multiple selections in one batch are ambiguous and all fail closed. A single failed
 * selection still counts as an attempt so the caller can revoke any previously persisted
 * slot proof before considering booking.apply from the same batch.
 */
export function executeBookingSlotSelectionBatch(params: {
  requests: RuntimeAgentToolRequest[];
  active_evidence: AvailabilityEvidence | null | undefined;
  subjects?: Array<{ id: SubjectId }> | null;
}): BookingSlotSelectionBatchResult {
  const selectRequests = params.requests.filter((request) => request.tool === "booking.select_slot");
  if (selectRequests.length === 0) {
    return { attempted: false, success_data: null, tool_results: [] };
  }

  if (selectRequests.length > 1) {
    return {
      attempted: true,
      success_data: null,
      tool_results: selectRequests.map((request) => ({
        tool: "booking.select_slot",
        call_id: request.call_id,
        status: "failed",
        error: { code: "ambiguous_selection", message: "ambiguous_selection" },
      })),
    };
  }

  const request = selectRequests[0];
  const result = executeBookingSelectSlot(
    request.arguments,
    params.active_evidence,
    params.subjects,
  );

  if (!result.ok) {
    return {
      attempted: true,
      success_data: null,
      tool_results: [{
        tool: "booking.select_slot",
        call_id: request.call_id,
        status: "failed",
        error: { code: result.reason, message: result.reason },
      }],
    };
  }

  return {
    attempted: true,
    success_data: result.data,
    tool_results: [{
      tool: "booking.select_slot",
      call_id: request.call_id,
      status: "success",
      data: result.data,
    }],
  };
}

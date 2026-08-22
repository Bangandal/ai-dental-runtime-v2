import type {
  ChannelContact,
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  RuntimeAgentTurnInput,
} from "./openaiRuntimeAgent.ts";
import type { ToolExecutorRegistry } from "./toolExecutor.ts";
import type { SubjectId } from "./bookingSubjectsState.ts";
import {
  computeBookingProcessState,
  type BookingProcessState,
} from "./bookingProcessState.ts";
import {
  executeBookingSelectSlotBatch,
  type BookingSelectSlotBatchResult,
} from "./bookingSelectSlot.ts";
import {
  resolveBookingSelectApplyBatchConflict,
  type BookingSelectApplyBatchConflict,
} from "./bookingSelectApplyBatchConflict.ts";
import { executeRuntimeNonWriteToolBatch } from "./runtimeNonWriteToolBatch.ts";
import { resolveAuthoritativeAvailabilityAttempt } from "./availabilityActionTruth.ts";

export interface ExecuteRuntimeToolBatchKernelParams {
  requests: RuntimeAgentToolRequest[];
  input: RuntimeAgentTurnInput;
  executors: ToolExecutorRegistry;
  prior_booking_process_state: BookingProcessState;
  subjects?: Array<{ id: SubjectId }> | null;
  channel_contact?: ChannelContact | null;
  now: Date;
}

export interface RuntimeToolBatchKernelResult {
  pending_booking_apply: RuntimeAgentToolRequest | null;
  select_apply_conflict: BookingSelectApplyBatchConflict | null;
  selection: BookingSelectSlotBatchResult;
  tool_results: RuntimeAgentToolResult[];
  booking_process_state: BookingProcessState;
  availability_diagnostic?: unknown;
}

/**
 * Deterministic non-write phase of one model tool batch.
 *
 * Ownership boundary:
 * - read tools execute here through the canonical runtime executor;
 * - booking.select_slot executes here through the slot-proof kernel;
 * - availability + selection are reduced into one booking-process-state transition;
 * - booking.apply is NEVER executed here. The caller receives it as pending and may
 *   evaluate/write only after this kernel has produced the new authoritative state.
 *
 * If select_slot + booking.apply coexist, the existing dependency-conflict guard owns
 * the whole batch and returns a protocol-complete result set. This kernel still updates
 * selection state so failed replacement revokes old proof and successful replacement is
 * persisted for a later model batch, but same-batch booking.apply remains blocked.
 */
export async function executeRuntimeToolBatchKernel(
  params: ExecuteRuntimeToolBatchKernelParams,
): Promise<RuntimeToolBatchKernelResult> {
  const pendingBookingApply = params.requests.find((request) => request.tool === "booking.apply") ?? null;

  const conflict = resolveBookingSelectApplyBatchConflict({
    requests: params.requests,
    activeEvidence: params.prior_booking_process_state.active_availability_evidence,
    subjects: params.subjects ?? null,
  });

  if (conflict) {
    const nextState = computeBookingProcessState({
      prior: params.prior_booking_process_state,
      channelContact: params.channel_contact ?? undefined,
      selectSlotData: conflict.selection.success_data,
      selectSlotAttemptedThisTurn: conflict.selection.attempted,
      now: params.now,
    });

    return {
      pending_booking_apply: pendingBookingApply,
      select_apply_conflict: conflict,
      selection: conflict.selection,
      tool_results: conflict.tool_results,
      booking_process_state: nextState,
    };
  }

  const selection = executeBookingSelectSlotBatch({
    requests: params.requests,
    activeEvidence: params.prior_booking_process_state.active_availability_evidence,
    subjects: params.subjects ?? null,
  });
  const nonWrite = await executeRuntimeNonWriteToolBatch({
    requests: params.requests,
    input: params.input,
    executors: params.executors,
    now: params.now,
  });

  const selectResults = [...selection.tool_results];
  const nonWriteResults = [...nonWrite.tool_results];
  let selectIndex = 0;
  let nonWriteIndex = 0;
  const orderedResults: RuntimeAgentToolResult[] = [];

  for (const request of params.requests) {
    if (request.tool === "booking.apply") continue;
    const result = request.tool === "booking.select_slot"
      ? selectResults[selectIndex++]
      : nonWriteResults[nonWriteIndex++];
    if (result) orderedResults.push(result);
  }

  const availabilityAttempt = resolveAuthoritativeAvailabilityAttempt(
    params.requests,
    orderedResults,
  );
  const nextState = computeBookingProcessState({
    prior: params.prior_booking_process_state,
    authoritativeAvailabilityAttempt: availabilityAttempt,
    channelContact: params.channel_contact ?? undefined,
    selectSlotData: selection.success_data,
    selectSlotAttemptedThisTurn: selection.attempted,
    now: params.now,
  });

  return {
    pending_booking_apply: pendingBookingApply,
    select_apply_conflict: null,
    selection,
    tool_results: orderedResults,
    booking_process_state: nextState,
    ...(nonWrite.availability_diagnostic !== undefined
      ? { availability_diagnostic: nonWrite.availability_diagnostic }
      : {}),
  };
}

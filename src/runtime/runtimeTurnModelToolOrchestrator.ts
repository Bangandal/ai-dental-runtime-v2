import type {
  BookingApplyResolution,
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  RuntimeAgentTurnInput,
} from "./openaiRuntimeAgent.ts";
import type { BookingSubjectsState, SubjectId } from "./bookingSubjectsState.ts";
import type { BookingProcessState } from "./bookingProcessState.ts";
import type { ToolExecutorRegistry } from "./toolExecutor.ts";
import type { RuntimeAgentCaller } from "./runtimeModelCall.ts";
import type { RuntimeModelIterationState } from "./runtimeModelIteration.ts";
import type { BookingApplyGuardedData, BookingApplyPastTimeDetail } from "./bookingApplyPreflightPolicy.ts";
import { executeRuntimeTurnToolBatch } from "./runtimeTurnToolBatch.ts";
import { getLegacyRuntimeTurnToolBatchDebugReason } from "./runtimeTurnToolBatchLegacyDebug.ts";
import { findLastAvailabilityRequest } from "./availabilityActionTruth.ts";
import { getTodayInTimezone, isPastBookingTime } from "./bookingPreflight.ts";
import {
  runRuntimeBoundedModelToolLoop,
  type RuntimeBoundedModelToolLoopOutcome,
} from "./runtimeBoundedModelToolLoop.ts";
import {
  buildRuntimeTurnModelProjection,
  type RuntimeTurnModelProjection,
} from "./runtimeTurnModelContext.ts";

export interface RuntimeTurnLoopDomainState {
  booking_process_state: BookingProcessState;
  effective_booking_subjects: BookingSubjectsState | null;
  bootstrapped_registry: BookingSubjectsState | null;
  execution_subject_id: SubjectId | null;
  booking_apply_resolution: BookingApplyResolution | null;
  last_guarded_booking_apply_data: BookingApplyGuardedData | null;
  processed_tool_requests: RuntimeAgentToolRequest[];
  tool_results: RuntimeAgentToolResult[];
  model_projection: RuntimeTurnModelProjection;
  tool_call_args: unknown[];
  last_debug_reason: string | null;
  availability_diagnostic?: unknown;
  past_time_detail: BookingApplyPastTimeDetail | null;
  missing_fields: string[] | null;
}

export type RuntimeTurnModelToolOrchestrationOutcome =
  RuntimeBoundedModelToolLoopOutcome<RuntimeTurnLoopDomainState>;

function projectToolCallArgs(requests: RuntimeAgentToolRequest[]): unknown[] {
  return requests.map((request) => {
    const args = request.arguments ?? {};
    if (request.tool === "availability.check") {
      return {
        tool: request.tool,
        requested_date: args.requested_date ?? null,
        requested_time: args.requested_time ?? null,
        service_interest: args.service_interest ?? null,
      };
    }
    if (request.tool === "booking.apply") {
      return {
        tool: request.tool,
        requested_date: args.requested_date ?? null,
        requested_time: args.requested_time ?? null,
        service: args.service ?? null,
      };
    }
    return { tool: request.tool };
  });
}

function resolvePastAvailabilityDetail(params: {
  requests: RuntimeAgentToolRequest[];
  timezone: string;
  now: Date;
}): BookingApplyPastTimeDetail | null {
  const request = findLastAvailabilityRequest(params.requests);
  if (!request) return null;
  const requestedTime = typeof request.arguments.requested_time === "string"
    ? request.arguments.requested_time
    : undefined;
  if (!requestedTime) return null;
  const requestedDate = typeof request.arguments.requested_date === "string"
    ? request.arguments.requested_date
    : undefined;
  if (!isPastBookingTime({
    requestedDate,
    requestedTime,
    timezone: params.timezone,
    now: params.now,
  })) return null;

  return {
    requestedDate,
    requestedTime,
    timezone: params.timezone,
    nowISO: params.now.toISOString(),
    todayInTimezone: getTodayInTimezone(params.now, params.timezone),
  };
}

/**
 * Runtime-specific model/tool orchestration built on the generic bounded iterator.
 *
 * There is no first/second business branch here. Every executable model tool batch is sent
 * through executeRuntimeTurnToolBatch(), then projected back to the model from cumulative
 * authoritative state. Model-call number survives only for legacy debug string translation.
 */
export async function runRuntimeTurnModelToolOrchestration(params: {
  model_state: RuntimeModelIterationState;
  caller: RuntimeAgentCaller;
  model: string;
  system_instruction: string;
  input: RuntimeAgentTurnInput;
  caller_context: Record<string, unknown>;
  executors: ToolExecutorRegistry;
  prior_booking_process_state: Partial<BookingProcessState> | null;
  initial_booking_process_state: BookingProcessState;
  now: Date;
  timezone: string;
  on_booking_process_state?: (state: BookingProcessState) => Promise<void> | void;
}): Promise<RuntimeTurnModelToolOrchestrationOutcome> {
  const initialProjection = buildRuntimeTurnModelProjection({
    caller_context: params.caller_context,
    prior_booking_process_state: params.prior_booking_process_state,
    booking_process_state: params.initial_booking_process_state,
    processed_tool_requests: [],
    tool_results: [],
    now: params.now,
    timezone: params.timezone,
  });

  const initialDomainState: RuntimeTurnLoopDomainState = {
    booking_process_state: params.initial_booking_process_state,
    effective_booking_subjects: params.input.booking_subjects ?? null,
    bootstrapped_registry: null,
    execution_subject_id: null,
    booking_apply_resolution: null,
    last_guarded_booking_apply_data: null,
    processed_tool_requests: [],
    tool_results: [],
    model_projection: initialProjection,
    tool_call_args: [],
    last_debug_reason: null,
    past_time_detail: null,
    missing_fields: null,
  };

  return await runRuntimeBoundedModelToolLoop({
    model_state: params.model_state,
    domain_state: initialDomainState,
    caller: params.caller,
    model: params.model,
    system_instruction: params.system_instruction,
    message: params.input.user_message,
    initial_context: initialProjection.context,
    async execute_batch({ requests, domain_state, batch_number }) {
      const processedToolRequests = [...domain_state.processed_tool_requests, ...requests];
      const toolCallArgs = [...domain_state.tool_call_args, ...projectToolCallArgs(requests)];

      // Availability requests for an explicitly expired time never reach the external
      // executor. Apply the same fail-closed rule to every executable batch rather than
      // tying it to a historical "round 1" branch.
      const pastTimeDetail = resolvePastAvailabilityDetail({
        requests,
        timezone: params.timezone,
        now: params.now,
      });
      if (pastTimeDetail) {
        return {
          kind: "abort" as const,
          reason: "availability_preflight_past_time",
          domain_state: {
            ...domain_state,
            processed_tool_requests: processedToolRequests,
            tool_call_args: toolCallArgs,
            last_debug_reason: "availability_preflight_past_time",
            past_time_detail: pastTimeDetail,
          },
        };
      }

      const effectiveInput = domain_state.effective_booking_subjects !== (params.input.booking_subjects ?? null)
        ? { ...params.input, booking_subjects: domain_state.effective_booking_subjects }
        : params.input;

      const batch = await executeRuntimeTurnToolBatch({
        requests,
        input: effectiveInput,
        executors: params.executors,
        booking_process_state: domain_state.booking_process_state,
        booking_subjects: domain_state.effective_booking_subjects,
        previous_tool_results: domain_state.tool_results,
        previous_booking_apply_resolution: domain_state.booking_apply_resolution,
        now: params.now,
        timezone: params.timezone,
      });

      const toolResults = [...domain_state.tool_results, ...batch.tool_results];
      const effectiveBookingSubjects = batch.effective_booking_subjects;
      const bookingApplyResolution = batch.booking_apply_resolution ?? domain_state.booking_apply_resolution;
      const executionSubjectId = batch.execution_subject_id ?? domain_state.execution_subject_id;
      const bootstrappedRegistry = batch.bootstrapped_registry ?? domain_state.bootstrapped_registry;
      const legacyBatchNumber: 1 | 2 = batch_number === 1 ? 1 : 2;
      const debugReason = getLegacyRuntimeTurnToolBatchDebugReason(batch, legacyBatchNumber)
        ?? (batch_number >= 2 ? "bounded_tool_batch_final_response" : domain_state.last_debug_reason);

      const projection = buildRuntimeTurnModelProjection({
        caller_context: params.caller_context,
        prior_booking_process_state: params.prior_booking_process_state,
        booking_process_state: batch.booking_process_state,
        processed_tool_requests: processedToolRequests,
        tool_results: toolResults,
        now: params.now,
        timezone: params.timezone,
      });

      if (params.on_booking_process_state) {
        await params.on_booking_process_state(batch.booking_process_state);
      }

      const nextDomainState: RuntimeTurnLoopDomainState = {
        booking_process_state: batch.booking_process_state,
        effective_booking_subjects: effectiveBookingSubjects,
        bootstrapped_registry: bootstrappedRegistry,
        execution_subject_id: executionSubjectId,
        booking_apply_resolution: bookingApplyResolution,
        last_guarded_booking_apply_data:
          batch.guarded_booking_apply_data ?? domain_state.last_guarded_booking_apply_data,
        processed_tool_requests: processedToolRequests,
        tool_results: toolResults,
        model_projection: projection,
        tool_call_args: toolCallArgs,
        last_debug_reason: debugReason,
        ...(batch.availability_diagnostic !== undefined
          ? { availability_diagnostic: batch.availability_diagnostic }
          : domain_state.availability_diagnostic !== undefined
            ? { availability_diagnostic: domain_state.availability_diagnostic }
            : {}),
        past_time_detail: batch.past_time_detail ?? domain_state.past_time_detail,
        missing_fields: batch.missing_fields ?? domain_state.missing_fields,
      };

      return {
        kind: "continue" as const,
        frame: {
          domain_state: nextDomainState,
          context: projection.context,
          tool_results: batch.tool_results,
          // A deterministic booking guard is terminal: the next model call may phrase the
          // result but may not initiate another action. select+apply conflict deliberately
          // returns no guarded data, allowing a later batch to retry apply with persisted proof.
          allow_tools: batch.guarded_booking_apply_data === null,
        },
      };
    },
  });
}

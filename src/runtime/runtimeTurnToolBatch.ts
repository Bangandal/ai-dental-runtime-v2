import type {
  BookingApplyResolution,
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  RuntimeAgentTurnInput,
} from "./openaiRuntimeAgent.ts";
import type { ToolExecutorRegistry } from "./toolExecutor.ts";
import type { BookingSubjectsState, SubjectId } from "./bookingSubjectsState.ts";
import { computeBookingProcessState, type BookingProcessState } from "./bookingProcessState.ts";
import { prepareBookingApplyExecution } from "./bookingApplyExecutionPreparation.ts";
import { deriveAgentFirstBookingSelection } from "./agentFirstBookingSlotBinding.ts";
import {
  completeRuntimeToolBatchWithBookingResult,
  executeRuntimeToolBatchKernel,
} from "./runtimeToolBatchKernel.ts";
import { shouldInterceptNoSlotsBeforeBookingApply } from "./bookingApplyPreflight.ts";
import {
  evaluateBookingApplyPreflightPolicy,
  type BookingApplyGuardedData,
  type BookingApplyPastTimeDetail,
  type BookingApplyPreflightGuardCode,
} from "./bookingApplyPreflightPolicy.ts";
import { executeRuntimeToolRequest, hasSubjectOrContactPhone } from "./runtimeToolRequestExecution.ts";

export type RuntimeTurnToolBatchDecision =
  | "no_booking_apply"
  | "select_apply_conflict"
  | "multiple_booking_apply"
  | "write_already_attempted"
  | "subject_validation_failed"
  | "subject_resolution_failed"
  | "no_available_slots"
  | "booking_preflight_blocked"
  | "booking_executed";

export interface RuntimeTurnToolBatchResult {
  tool_results: RuntimeAgentToolResult[];
  booking_process_state: BookingProcessState;
  effective_booking_subjects: BookingSubjectsState | null;
  bootstrapped_registry: BookingSubjectsState | null;
  execution_subject_id: SubjectId | null;
  booking_apply_resolution: BookingApplyResolution | null;
  guarded_booking_apply_data: BookingApplyGuardedData | null;
  booking_preflight_guard_code: BookingApplyPreflightGuardCode | null;
  past_time_detail: BookingApplyPastTimeDetail | null;
  missing_fields: string[] | null;
  availability_diagnostic?: unknown;
  decision: RuntimeTurnToolBatchDecision;
}

function buildProtocolCompleteBookingBlock(params: {
  requests: RuntimeAgentToolRequest[];
  guardedData: BookingApplyGuardedData;
}): RuntimeAgentToolResult[] {
  return params.requests.map((request) => {
    if (request.tool === "booking.apply") {
      return {
        tool: "booking.apply",
        call_id: request.call_id,
        status: "success" as const,
        data: params.guardedData,
      };
    }
    return {
      tool: request.tool,
      call_id: request.call_id,
      status: "denied" as const,
      error: {
        code: "turn_aborted_due_to_multiple_booking_requests",
        message: "turn_aborted_due_to_multiple_booking_requests",
      },
    };
  });
}

function multipleBookingGuard(): BookingApplyGuardedData {
  return {
    booking_status: "subject_resolution_conflict",
    created_visit: false,
    may_claim_booked: false,
    required_next_action: "clarify_subject",
    reason: "multiple_booking_apply_requests",
  };
}

/**
 * Execute one complete runtime tool batch without any knowledge of model-call rounds.
 *
 * Ordering is intentionally strict:
 * 1. enforce one booking write request / one write attempt per patient turn;
 * 2. prepare the deterministic booking subject (bootstrap/freeze identity);
 * 3. execute non-write tools + slot selection and reduce authoritative booking state;
 * 4. in agent-first mode only, derive the old slot-selection proof internally when the
 *    direct booking.apply slot exactly belongs to fresh authoritative evidence;
 * 5. only then evaluate booking legality against that new state;
 * 6. execute booking.apply at most once and reassemble one result per call id in request order.
 *
 * This is the phase-independent bridge between the model/tool transport loop and the
 * deterministic booking kernel. It never invokes the model and never decides conversation
 * dirty/resumable policy.
 */
export async function executeRuntimeTurnToolBatch(params: {
  requests: RuntimeAgentToolRequest[];
  input: RuntimeAgentTurnInput;
  executors: ToolExecutorRegistry;
  booking_process_state: BookingProcessState;
  booking_subjects: BookingSubjectsState | null;
  previous_tool_results?: RuntimeAgentToolResult[];
  previous_booking_apply_resolution?: BookingApplyResolution | null;
  now: Date;
  timezone: string;
}): Promise<RuntimeTurnToolBatchResult> {
  const bookingRequests = params.requests.filter((request) => request.tool === "booking.apply");
  const pendingBookingApply = bookingRequests.length === 1 ? bookingRequests[0] : null;

  if (bookingRequests.length > 1) {
    const guardedData = multipleBookingGuard();
    return {
      tool_results: buildProtocolCompleteBookingBlock({ requests: params.requests, guardedData }),
      booking_process_state: params.booking_process_state,
      effective_booking_subjects: params.booking_subjects,
      bootstrapped_registry: null,
      execution_subject_id: null,
      booking_apply_resolution: null,
      guarded_booking_apply_data: guardedData,
      booking_preflight_guard_code: null,
      past_time_detail: null,
      missing_fields: null,
      decision: "multiple_booking_apply",
    };
  }

  if (pendingBookingApply && params.previous_booking_apply_resolution) {
    const guardedData = multipleBookingGuard();
    return {
      tool_results: buildProtocolCompleteBookingBlock({ requests: params.requests, guardedData }),
      booking_process_state: params.booking_process_state,
      effective_booking_subjects: params.booking_subjects,
      bootstrapped_registry: null,
      execution_subject_id: null,
      booking_apply_resolution: null,
      guarded_booking_apply_data: guardedData,
      booking_preflight_guard_code: null,
      past_time_detail: null,
      missing_fields: null,
      decision: "write_already_attempted",
    };
  }

  const preparation = pendingBookingApply
    ? prepareBookingApplyExecution({
        booking_apply: pendingBookingApply,
        booking_subjects: params.booking_subjects,
        channel_contact: params.input.channel_contact ?? null,
        current_turn_typed_phone: params.input.current_turn_typed_phone ?? null,
      })
    : null;

  const effectiveBookingSubjects = preparation?.effective_booking_subjects ?? params.booking_subjects;
  const effectiveInput = effectiveBookingSubjects !== (params.input.booking_subjects ?? null)
    ? { ...params.input, booking_subjects: effectiveBookingSubjects }
    : params.input;

  const kernel = await executeRuntimeToolBatchKernel({
    requests: params.requests,
    input: effectiveInput,
    executors: params.executors,
    prior_booking_process_state: params.booking_process_state,
    subjects: effectiveBookingSubjects?.subjects ?? null,
    channel_contact: params.input.channel_contact ?? null,
    now: params.now,
  });

  const executionSubjectId = preparation?.ok ? preparation.execution_subject_id : null;
  let bookingProcessState = kernel.booking_process_state;

  // Agent-first removes model-facing booking.select_slot ceremony without weakening its
  // authorization invariant. After subject preparation has frozen the execution patient,
  // reuse the existing selector against fresh authoritative evidence. If any condition
  // fails, no proof is synthesized and the unchanged preflight blocks booking.apply.
  if (
    pendingBookingApply &&
    preparation?.ok &&
    !kernel.select_apply_conflict &&
    !bookingProcessState.selected_slot_proof
  ) {
    const internalSelection = deriveAgentFirstBookingSelection({
      booking_apply: pendingBookingApply,
      execution_subject_id: executionSubjectId,
      booking_process_state: bookingProcessState,
      subjects: effectiveBookingSubjects?.subjects ?? null,
      now: params.now,
    });

    if (internalSelection) {
      bookingProcessState = computeBookingProcessState({
        prior: bookingProcessState,
        channelContact: params.input.channel_contact,
        selectSlotData: internalSelection,
        selectSlotAttemptedThisTurn: true,
        bookingApplyService:
          typeof pendingBookingApply.arguments.service === "string"
            ? pendingBookingApply.arguments.service
            : null,
        bookingApplyFirstName:
          typeof pendingBookingApply.arguments.first_name === "string"
            ? pendingBookingApply.arguments.first_name
            : null,
        bookingApplyLastName:
          typeof pendingBookingApply.arguments.last_name === "string"
            ? pendingBookingApply.arguments.last_name
            : null,
        now: params.now,
      });
    }
  }

  const common = {
    booking_process_state: bookingProcessState,
    effective_booking_subjects: effectiveBookingSubjects,
    bootstrapped_registry: preparation?.bootstrapped_registry ?? null,
    availability_diagnostic: kernel.availability_diagnostic,
  };

  if (kernel.select_apply_conflict) {
    return {
      tool_results: kernel.tool_results,
      ...common,
      execution_subject_id: null,
      booking_apply_resolution: null,
      guarded_booking_apply_data: null,
      booking_preflight_guard_code: null,
      past_time_detail: null,
      missing_fields: null,
      decision: "select_apply_conflict",
    };
  }

  if (!pendingBookingApply) {
    return {
      tool_results: kernel.tool_results,
      ...common,
      execution_subject_id: null,
      booking_apply_resolution: null,
      guarded_booking_apply_data: null,
      booking_preflight_guard_code: null,
      past_time_detail: null,
      missing_fields: null,
      decision: "no_booking_apply",
    };
  }

  let guardedData: BookingApplyGuardedData | null = null;
  let guardCode: BookingApplyPreflightGuardCode | null = null;
  let pastTimeDetail: BookingApplyPastTimeDetail | null = null;
  let missingFields: string[] | null = null;
  let decision: RuntimeTurnToolBatchDecision;

  if (preparation && !preparation.ok) {
    guardedData = {
      booking_status: "subject_resolution_conflict",
      created_visit: false,
      may_claim_booked: false,
      required_next_action: "clarify_subject",
      reason: preparation.reason,
    };
    decision = preparation.stage === "subject_validation"
      ? "subject_validation_failed"
      : "subject_resolution_failed";
  } else {
    const completedBeforeBooking = [
      ...(params.previous_tool_results ?? []),
      ...kernel.tool_results,
    ];

    if (shouldInterceptNoSlotsBeforeBookingApply({
      pendingToolRequests: params.requests,
      completedToolResults: completedBeforeBooking,
    })) {
      guardedData = {
        booking_status: "no_available_slots",
        created_visit: false,
        may_claim_booked: false,
        required_next_action: "ask_for_alternative_time",
        reason: "availability_check_returned_no_slots",
      };
      decision = "no_available_slots";
    } else {
      const preflight = evaluateBookingApplyPreflightPolicy({
        pendingBookingApply,
        pendingToolRequests: params.requests,
        pendingTypedPhone: Boolean(effectiveBookingSubjects?.pending_typed_phone),
        hasBookingPhone: hasSubjectOrContactPhone(effectiveInput, executionSubjectId),
        activeAvailabilityEvidence: bookingProcessState.active_availability_evidence,
        selectedSlot: bookingProcessState.selected_slot,
        selectedSlotProof: bookingProcessState.selected_slot_proof,
        timezone: params.timezone,
        now: params.now,
      });

      if (preflight.outcome === "block") {
        guardedData = preflight.guarded_data;
        guardCode = preflight.guard_code;
        pastTimeDetail = preflight.past_time_detail ?? null;
        missingFields = preflight.missing_fields ?? null;
        decision = "booking_preflight_blocked";
      } else {
        const execution = await executeRuntimeToolRequest({
          input: effectiveInput,
          request: pendingBookingApply,
          executors: params.executors,
          now: params.now,
          execution_subject_id: executionSubjectId,
        });
        const bookingResolution: BookingApplyResolution | null = executionSubjectId
          ? { call_id: pendingBookingApply.call_id, subject_id: executionSubjectId }
          : null;

        return {
          tool_results: completeRuntimeToolBatchWithBookingResult({
            requests: params.requests,
            partial_results: kernel.tool_results,
            booking_result: execution.tool_result,
          }),
          ...common,
          execution_subject_id: executionSubjectId,
          booking_apply_resolution: bookingResolution,
          guarded_booking_apply_data: null,
          booking_preflight_guard_code: null,
          past_time_detail: null,
          missing_fields: null,
          decision: "booking_executed",
        };
      }
    }
  }

  const bookingResult: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: pendingBookingApply.call_id,
    status: "success",
    data: guardedData!,
  };

  return {
    tool_results: completeRuntimeToolBatchWithBookingResult({
      requests: params.requests,
      partial_results: kernel.tool_results,
      booking_result: bookingResult,
    }),
    ...common,
    execution_subject_id: executionSubjectId,
    booking_apply_resolution: null,
    guarded_booking_apply_data: guardedData,
    booking_preflight_guard_code: guardCode,
    past_time_detail: pastTimeDetail,
    missing_fields: missingFields,
    decision,
  };
}

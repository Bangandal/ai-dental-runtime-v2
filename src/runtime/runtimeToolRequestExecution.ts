import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  RuntimeAgentTurnInput,
} from "./openaiRuntimeAgent.ts";
import type { SubjectId } from "./bookingSubjectsState.ts";
import { hasBookingContactPhone } from "./bookingContactGuard.ts";
import { applyToolPolicy, type PlannerOutput, type TruthSnapshot } from "./toolPolicy.ts";
import {
  executeAllowedTools,
  type ToolExecutorRegistry,
  type ToolExecutionContext,
} from "./toolExecutor.ts";
import { buildTruthSnapshot } from "./truthSnapshot.ts";
import type { ToolExecutionResult } from "./toolResults.ts";

export interface ExecuteRuntimeToolRequestParams {
  input: RuntimeAgentTurnInput;
  request: RuntimeAgentToolRequest;
  executors: ToolExecutorRegistry;
  now?: Date;
  execution_subject_id?: SubjectId | null;
}

export interface ExecuteRuntimeToolRequestResult {
  tool_result: RuntimeAgentToolResult;
  availability_diagnostic?: unknown;
}

/**
 * Execute one policy-backed runtime tool request through the canonical deterministic
 * pipeline: planner projection -> truth snapshot -> policy -> execution context ->
 * executor -> normalized Runtime tool result.
 *
 * booking.select_slot is intentionally not owned here. It has its own pure batch kernel
 * because slot-proof state transitions must be coordinated at the tool-batch boundary.
 */
export async function executeRuntimeToolRequest(
  params: ExecuteRuntimeToolRequestParams,
): Promise<ExecuteRuntimeToolRequestResult> {
  const planner = buildPlannerFromAgentToolRequest(params.request);
  const truth = resolveTruthSnapshot(params.input, params.request, planner, params.now);
  const policy = applyToolPolicy(planner, truth);

  if (policy.tools_denied.length > 0 || policy.tools_allowed.length === 0) {
    const denial = policy.tools_denied[0];
    return {
      tool_result: {
        tool: params.request.tool,
        call_id: params.request.call_id,
        status: "denied",
        error: {
          code: denial?.reason ?? "policy_denied",
          message: `Tool denied by policy: ${denial?.reason ?? "unknown"}`,
        },
      },
    };
  }

  const context = buildExecutionContext(
    params.input,
    params.request,
    planner,
    truth,
    params.now,
    params.execution_subject_id,
  );
  const executionResults = await executeAllowedTools({
    tools_allowed: policy.tools_allowed,
    registry: params.executors,
    context,
  });
  const execResult = executionResults[0];
  const toolResult = convertToolExecutionResult(params.request, execResult);

  return {
    tool_result: toolResult,
    ...(execResult?.tool === "availability.check"
      && execResult.status === "success"
      && execResult._diagnostic !== undefined
      ? { availability_diagnostic: execResult._diagnostic }
      : {}),
  };
}

function buildPlannerFromAgentToolRequest(request: RuntimeAgentToolRequest): PlannerOutput {
  if (request.tool === "availability.check") {
    return {
      confidence: "high",
      tools_requested: ["availability.check"],
      reply_strategy: "answer_only",
      turn_type: "availability_request",
      booking_action: "check_availability",
    };
  }

  if (request.tool === "booking.apply") {
    return {
      confidence: "high",
      tools_requested: ["booking.apply"],
      reply_strategy: "answer_only",
      turn_type: "booking",
      booking_action: "confirm",
      explicit_patient_confirmation: true,
      booking_request: {
        service: typeof request.arguments.service === "string" ? request.arguments.service : null,
        preferred_date_text: typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : null,
        preferred_time_text: typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null,
      },
    };
  }

  if (request.tool === "appointment.lookup") {
    return {
      confidence: "high",
      tools_requested: ["appointment.lookup"],
      reply_strategy: "answer_only",
      turn_type: "faq",
      booking_action: null,
    };
  }

  return {
    confidence: "high",
    tools_requested: ["kb.search"],
    reply_strategy: "answer_only",
    turn_type: "faq",
    booking_action: null,
  };
}

function resolveTruthSnapshot(
  input: RuntimeAgentTurnInput,
  request: RuntimeAgentToolRequest,
  planner: PlannerOutput,
  now?: Date,
): TruthSnapshot {
  const provided = input.truth_snapshot;
  if (provided && typeof provided === "object") {
    const typed = provided as Partial<TruthSnapshot>;
    if (typeof typed.scheduling_intent_present === "boolean" && typeof typed.date_or_time_present === "boolean") {
      return typed as TruthSnapshot;
    }
  }

  return buildTruthSnapshot({
    planner,
    now,
    current_turn_flags: {
      scheduling_intent_present: request.tool === "availability.check" || request.tool === "booking.apply",
      date_or_time_present: typeof request.arguments.requested_date === "string"
        || typeof request.arguments.requested_time === "string",
    },
  });
}

function buildExecutionContext(
  input: RuntimeAgentTurnInput,
  request: RuntimeAgentToolRequest,
  planner: PlannerOutput,
  truth_snapshot: TruthSnapshot,
  now?: Date,
  executionSubjectId?: SubjectId | null,
): ToolExecutionContext {
  const serviceInterest =
    typeof request.arguments.service_interest === "string"
      ? request.arguments.service_interest
      : typeof request.arguments.service === "string"
        ? request.arguments.service
        : null;

  return {
    trace_id: input.trace_id,
    clinic_id: input.clinic_id,
    contact_id: input.contact_id ?? undefined,
    case_id: input.case_id ?? undefined,
    locale: input.locale,
    query_text: typeof request.arguments.query === "string" ? request.arguments.query : undefined,
    requested_date: typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : undefined,
    requested_time: typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null,
    service_interest: serviceInterest,
    limit: typeof request.arguments.limit === "number" ? request.arguments.limit : undefined,
    timezone: typeof request.arguments.timezone === "string" ? request.arguments.timezone : undefined,
    planner,
    truth_snapshot,
    now,
    first_name: typeof request.arguments.first_name === "string" ? request.arguments.first_name : undefined,
    last_name: typeof request.arguments.last_name === "string" ? request.arguments.last_name : undefined,
    ...(request.tool === "appointment.lookup"
      ? {
          phone_number: input.channel_contact?.phone_number,
          phone_source: input.channel_contact?.phone_source,
          phone_trust: undefined,
          lookup_subject_id: typeof request.arguments.subject_id === "string" ? request.arguments.subject_id : undefined,
          lookup_date_from: typeof request.arguments.date_from === "string" ? request.arguments.date_from : undefined,
          lookup_date_to: typeof request.arguments.date_to === "string" ? request.arguments.date_to : undefined,
          lookup_booking_subjects: input.booking_subjects
            ? {
                subjects: (input.booking_subjects.subjects as Array<{
                  id: string;
                  booking_contact: {
                    phone_number: string;
                    source: string;
                    owner_subject_id?: string | null;
                  } | null;
                }>).map((subject) => ({
                  id: subject.id,
                  booking_contact: subject.booking_contact
                    ? {
                        phone_number: subject.booking_contact.phone_number,
                        source: subject.booking_contact.source,
                        owner_subject_id: (subject.booking_contact as Record<string, unknown>).owner_subject_id as string | null ?? null,
                      }
                    : null,
                })),
              }
            : null,
        }
      : buildSubjectAwarePhoneFields(input, executionSubjectId)),
  } as ToolExecutionContext;
}

type SubjectLike = { id: string; booking_contact?: unknown };

function resolveBookingContactFields(
  bookingContact: Record<string, unknown>,
  allSubjects: SubjectLike[],
): {
  phone_number: string | undefined;
  phone_source: string | undefined;
  phone_trust: string | undefined;
} {
  if (bookingContact.source === "shared_from_subject") {
    const ownerId = bookingContact.owner_subject_id as string | null | undefined;
    if (!ownerId) return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
    const owner = allSubjects.find((subject) => subject.id === ownerId);
    const ownerContact = (owner?.booking_contact ?? null) as Record<string, unknown> | null;
    if (!ownerContact?.phone_number) {
      return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
    }
    return {
      phone_number: ownerContact.phone_number as string,
      phone_source: ownerContact.source as string | undefined,
      phone_trust: ownerContact.trust === "trusted" ? "trusted" : "unverified",
    };
  }

  return {
    phone_number: bookingContact.phone_number as string,
    phone_source: bookingContact.source as string | undefined,
    phone_trust: bookingContact.trust === "trusted" || bookingContact.trust === "trusted_contact_owner"
      ? "trusted"
      : "unverified",
  };
}

/**
 * Resolve booking-contact fields from the frozen execution patient. This preserves the
 * existing responsible-party fallback without allowing patient identity to follow a phone.
 */
export function buildSubjectAwarePhoneFields(
  input: RuntimeAgentTurnInput,
  executionSubjectId?: SubjectId | null,
): {
  phone_number: string | undefined;
  phone_source: string | undefined;
  phone_trust: string | undefined;
  contact_phone_owner_subject_id?: string | null;
} {
  if (input.booking_subjects) {
    if (!executionSubjectId) {
      return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
    }
    const subjects = input.booking_subjects.subjects as SubjectLike[];
    const target = subjects.find((subject) => subject.id === executionSubjectId);
    const bookingContact = (target?.booking_contact ?? null) as Record<string, unknown> | null;
    if (bookingContact?.phone_number) return resolveBookingContactFields(bookingContact, subjects);

    if (executionSubjectId !== ("subject_1" as SubjectId)) {
      const sender = subjects.find((subject) => subject.id === "subject_1");
      const senderContact = (sender?.booking_contact ?? null) as Record<string, unknown> | null;
      if (senderContact?.phone_number && senderContact.trust === "trusted") {
        return {
          ...resolveBookingContactFields(senderContact, subjects),
          contact_phone_owner_subject_id: "subject_1",
        };
      }
      if (input.channel_contact?.phone_number) {
        return {
          phone_number: input.channel_contact.phone_number,
          phone_source: input.channel_contact.phone_source,
          phone_trust: undefined,
        };
      }
    }
    return { phone_number: undefined, phone_source: undefined, phone_trust: undefined };
  }

  const isCurrentTurnTypedPhone =
    input.current_turn_typed_phone != null
    && input.provided_phone?.phone_source === "typed"
    && input.provided_phone.phone_number === input.current_turn_typed_phone;
  const suppressTypedPhone =
    input.had_booking_subjects
    && input.provided_phone?.phone_source === "typed"
    && !isCurrentTurnTypedPhone;
  const effectiveProvided = suppressTypedPhone ? null : (input.provided_phone ?? null);
  return {
    phone_number: effectiveProvided?.phone_number ?? input.channel_contact?.phone_number,
    phone_source: effectiveProvided?.phone_source ?? input.channel_contact?.phone_source,
    phone_trust: effectiveProvided ? effectiveProvided.phone_trust : undefined,
  };
}

/** True when the frozen execution patient has a usable booking contact. */
export function hasSubjectOrContactPhone(
  input: RuntimeAgentTurnInput,
  executionSubjectId: SubjectId | null,
): boolean {
  if (input.booking_subjects) {
    if (!executionSubjectId) return false;
    const subjects = input.booking_subjects.subjects as SubjectLike[];
    const target = subjects.find((subject) => subject.id === executionSubjectId);
    const bookingContact = (target?.booking_contact ?? null) as Record<string, unknown> | null;
    if (!bookingContact?.phone_number) {
      if (executionSubjectId !== ("subject_1" as SubjectId)) {
        const sender = subjects.find((subject) => subject.id === "subject_1");
        const senderContact = (sender?.booking_contact ?? null) as Record<string, unknown> | null;
        if (senderContact?.phone_number && senderContact.trust === "trusted") return true;
        return hasBookingContactPhone({ channelContact: input.channel_contact, providedPhone: null });
      }
      return false;
    }
    if (bookingContact.source === "shared_from_subject") {
      const ownerId = bookingContact.owner_subject_id as string | null | undefined;
      if (!ownerId) return false;
      const owner = subjects.find((subject) => subject.id === ownerId);
      const ownerContact = (owner?.booking_contact ?? null) as Record<string, unknown> | null;
      return ownerContact?.phone_number != null;
    }
    return true;
  }

  const isCurrentTurnTypedPhone =
    input.current_turn_typed_phone != null
    && input.provided_phone?.phone_source === "typed"
    && input.provided_phone.phone_number === input.current_turn_typed_phone;
  const suppressTypedPhone =
    input.had_booking_subjects
    && input.provided_phone?.phone_source === "typed"
    && !isCurrentTurnTypedPhone;
  const effectiveProvided = suppressTypedPhone ? null : (input.provided_phone ?? null);
  return hasBookingContactPhone({ channelContact: input.channel_contact, providedPhone: effectiveProvided });
}

function convertToolExecutionResult(
  request: RuntimeAgentToolRequest,
  result: ToolExecutionResult | undefined,
): RuntimeAgentToolResult {
  if (!result) {
    return {
      tool: request.tool,
      call_id: request.call_id,
      status: "failed",
      error: { code: "missing_execution_result", message: "Tool execution produced no result" },
    };
  }

  if (result.status === "success") {
    return { tool: request.tool, call_id: request.call_id, status: "success", data: result.data };
  }

  if (result.status === "not_implemented") {
    return {
      tool: request.tool,
      call_id: request.call_id,
      status: "failed",
      error: result.error ?? {
        code: "tool_not_implemented",
        message: "Tool not implemented",
        retryable: false,
      },
    };
  }

  return {
    tool: request.tool,
    call_id: request.call_id,
    status: "failed",
    error: result.error,
  };
}

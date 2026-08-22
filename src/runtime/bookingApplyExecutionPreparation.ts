import type { ChannelContact, RuntimeAgentToolRequest } from "./openaiRuntimeAgent.ts";
import { resolveBookingExecutionSubject, type SubjectResolutionConflictReason } from "./bookingSubjectExecutionResolver.ts";
import {
  bootstrapRegistryFromBookingApplyArgs,
  parseSubjectTarget,
  type BookingSubjectsState,
  type ParsedSubjectTarget,
  type SubjectId,
} from "./bookingSubjectsState.ts";

export type BookingApplyPreparationFailureStage = "subject_validation" | "subject_resolution";

export type BookingApplyExecutionPreparation =
  | {
      ok: true;
      execution_subject_id: SubjectId;
      effective_booking_subjects: BookingSubjectsState | null;
      bootstrapped_registry: BookingSubjectsState | null;
    }
  | {
      ok: false;
      stage: BookingApplyPreparationFailureStage;
      reason: Extract<ParsedSubjectTarget, { ok: false }>["reason"] | SubjectResolutionConflictReason;
      effective_booking_subjects: BookingSubjectsState | null;
      bootstrapped_registry: BookingSubjectsState | null;
    };

export interface PrepareBookingApplyExecutionParams {
  booking_apply: RuntimeAgentToolRequest;
  booking_subjects: BookingSubjectsState | null;
  channel_contact: ChannelContact | null;
  current_turn_typed_phone: string | null;
}

/**
 * Prepare the deterministic patient target for one booking.apply request.
 *
 * This boundary is deliberately independent of LLM call number. It owns the legacy
 * subject plumbing that must happen before business preflight / write execution:
 * - bootstrap a missing multi-person registry when the internal target is subject_2+;
 * - strictly validate subject_1..subject_4;
 * - resolve/freeze the execution subject against an active registry.
 *
 * The caller still owns *when* a returned conflict becomes authoritative. In particular,
 * the historical same-batch select_slot + booking.apply Guard S may intentionally consume
 * the bootstrap while deferring/ignoring target conflicts for that blocked apply call.
 */
export function prepareBookingApplyExecution(
  params: PrepareBookingApplyExecutionParams,
): BookingApplyExecutionPreparation {
  let effectiveBookingSubjects = params.booking_subjects;
  let bootstrappedRegistry: BookingSubjectsState | null = null;

  if (!effectiveBookingSubjects) {
    bootstrappedRegistry = bootstrapRegistryFromBookingApplyArgs(
      params.booking_apply.arguments,
      params.channel_contact,
      params.current_turn_typed_phone,
    );
    if (bootstrappedRegistry) {
      effectiveBookingSubjects = bootstrappedRegistry;
    }
  }

  const parsedTarget = parseSubjectTarget(params.booking_apply.arguments.subject_id);
  if (!parsedTarget.ok) {
    return {
      ok: false,
      stage: "subject_validation",
      reason: parsedTarget.reason,
      effective_booking_subjects: effectiveBookingSubjects,
      bootstrapped_registry: bootstrappedRegistry,
    };
  }

  if (!effectiveBookingSubjects) {
    return {
      ok: true,
      execution_subject_id: parsedTarget.subject_id,
      effective_booking_subjects: null,
      bootstrapped_registry: null,
    };
  }

  const resolution = resolveBookingExecutionSubject(
    effectiveBookingSubjects,
    params.booking_apply.arguments,
  );
  if (!resolution.ok) {
    return {
      ok: false,
      stage: "subject_resolution",
      reason: resolution.reason,
      effective_booking_subjects: effectiveBookingSubjects,
      bootstrapped_registry: bootstrappedRegistry,
    };
  }

  return {
    ok: true,
    execution_subject_id: resolution.execution_subject_id,
    effective_booking_subjects: effectiveBookingSubjects,
    bootstrapped_registry: bootstrappedRegistry,
  };
}

import type { PlannerOutput, TruthSnapshot, TurnType } from "./toolPolicy.ts";

export interface TruthSnapshotInput {
  active_hold?: {
    id?: string | null;
    expires_at?: string | Date | null;
    contact_id?: string | null;
    case_id?: string | null;
  } | null;
  current_contact_id?: string | null;
  current_case_id?: string | null;
  availability_result?: {
    slots?: unknown[];
  } | null;
  proposed_slot?: unknown | null;
  service_interest?: string | null;
  planner?: PlannerOutput;
  now?: Date;
  current_turn_flags?: {
    contradiction_in_turn?: boolean;
    explicit_slot_rejection?: boolean;
    explicit_cancellation_request?: boolean;
    scheduling_intent_present?: boolean;
    date_or_time_present?: boolean;
  };
}

const SCHEDULING_TURN_TYPES = new Set<TurnType>([
  "booking",
  "availability_request",
  "reschedule",
]);

function hasNonEmptyText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isFutureDate(value: string | Date | null | undefined, now: Date): boolean {
  if (!value) {
    return false;
  }

  const parsedDate = value instanceof Date ? value : new Date(value);
  const time = parsedDate.getTime();
  if (Number.isNaN(time)) {
    return false;
  }

  return time > now.getTime();
}

export function buildTruthSnapshot(input: TruthSnapshotInput): TruthSnapshot {
  const now = input.now ?? new Date();
  const activeHold = input.active_hold ?? null;

  const activeHoldExists = hasNonEmptyText(activeHold?.id);

  const holdNotExpired =
    activeHoldExists && isFutureDate(activeHold?.expires_at ?? null, now);

  let contactCaseMatch = false;
  if (activeHoldExists) {
    const hasContactToCheck = hasNonEmptyText(input.current_contact_id);
    const hasCaseToCheck = hasNonEmptyText(input.current_case_id);

    const contactMatches = !hasContactToCheck
      || activeHold?.contact_id === input.current_contact_id;
    const caseMatches = !hasCaseToCheck
      || activeHold?.case_id === input.current_case_id;

    contactCaseMatch = contactMatches && caseMatches;
  }

  const slots = input.availability_result?.slots;
  const availabilityResultExists = Array.isArray(slots) && slots.length > 0;

  const plannerService = input.planner?.booking_request?.service;
  const serviceKnown =
    hasNonEmptyText(input.service_interest) || hasNonEmptyText(plannerService);

  const contradictionInTurn = Boolean(
    input.current_turn_flags?.contradiction_in_turn,
  );

  const explicitSlotRejection = Boolean(
    input.current_turn_flags?.explicit_slot_rejection,
  );

  const explicitCancellationRequest = Boolean(
    input.current_turn_flags?.explicit_cancellation_request,
  );

  const schedulingIntentPresent =
    input.current_turn_flags?.scheduling_intent_present
    ?? Boolean(
      input.planner?.turn_type && SCHEDULING_TURN_TYPES.has(input.planner.turn_type),
    );

  const dateOrTimePresent =
    input.current_turn_flags?.date_or_time_present
    ?? Boolean(
      hasNonEmptyText(input.planner?.booking_request?.preferred_date_text)
      || hasNonEmptyText(input.planner?.booking_request?.preferred_time_text),
    );

  return {
    active_hold_exists: activeHoldExists,
    hold_not_expired: holdNotExpired,
    contact_case_match: contactCaseMatch,
    contradiction_in_turn: contradictionInTurn,
    availability_result_exists: availabilityResultExists,
    proposed_slot_exists: input.proposed_slot !== null && input.proposed_slot !== undefined,
    service_known: serviceKnown,
    explicit_slot_rejection: explicitSlotRejection,
    explicit_cancellation_request: explicitCancellationRequest,
    scheduling_intent_present: schedulingIntentPresent,
    date_or_time_present: dateOrTimePresent,
  };
}

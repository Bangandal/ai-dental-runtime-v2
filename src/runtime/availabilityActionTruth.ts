import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";

export type AvailabilityOutcome =
  | "slots_available"
  | "no_slots"
  | "past_date"
  | "technical_failure"
  | "denied";

export type AvailabilityRequiredNextAction =
  | "choose_slot"
  | "ask_for_alternative_time"
  | "ask_for_future_date"
  | "retry_or_contact_clinic";

export interface AvailabilityActionTruth {
  outcome: AvailabilityOutcome;
  requested_date: string | null;
  requested_time: string | null;
  can_present_slots: boolean;
  required_next_action: AvailabilityRequiredNextAction;
  /** HH:MM values only — same format as availability_presentation_truth.allowed_slot_starts. */
  allowed_slot_starts: string[];
}

/** Extracts HH:MM from an ISO starts_at string or a bare "HH:MM" string. */
export function extractSlotHHMM(startsAt: unknown): string | null {
  if (typeof startsAt !== "string") return null;
  const iso = startsAt.match(/T(\d{2}:\d{2})(?::\d{2})?/);
  if (iso) return iso[1];
  const bare = startsAt.match(/^(\d{2}:\d{2})$/);
  return bare ? bare[1] : null;
}

export interface AuthoritativeAvailabilityPair {
  request: RuntimeAgentToolRequest;
  result: RuntimeAgentToolResult;
}

/**
 * Returns the authoritative availability pair for the current round:
 *   - the LAST availability.check request by position in requests
 *   - paired strictly with the result that shares its call_id
 *
 * Returns null when:
 *   - no availability.check request is present
 *   - the last request has no call_id (missing call_id must never authorize slot presentation)
 *   - no result with a matching call_id exists
 *
 * Earlier requests in the same round are superseded by the last one.
 */
export function findLastAuthoritativeAvailabilityPair(
  requests: RuntimeAgentToolRequest[],
  results: RuntimeAgentToolResult[],
): AuthoritativeAvailabilityPair | null {
  let lastRequest: RuntimeAgentToolRequest | undefined;
  for (const r of requests) {
    if (r.tool === "availability.check") lastRequest = r;
  }
  if (!lastRequest) return null;

  // Require call_id — unkeyed requests must not accidentally pair with any result.
  if (!lastRequest.call_id) return null;

  const result = results.find(
    (r) => r.tool === "availability.check" && r.call_id === lastRequest!.call_id,
  );
  if (!result) return null;

  return { request: lastRequest, result };
}

function extractAllowedSlotStarts(result: RuntimeAgentToolResult): string[] {
  const data = result.data as { slots?: unknown[] } | null | undefined;
  if (!Array.isArray(data?.slots)) return [];
  const starts: string[] = [];
  for (const s of data!.slots!) {
    if (s && typeof s === "object") {
      const raw = s as { starts_at?: unknown };
      const hhmm = extractSlotHHMM(raw.starts_at);
      if (hhmm !== null) starts.push(hhmm);
    }
  }
  return starts;
}

export function buildAvailabilityActionTruth(
  requests: RuntimeAgentToolRequest[],
  results: RuntimeAgentToolResult[],
): AvailabilityActionTruth | null {
  const pair = findLastAuthoritativeAvailabilityPair(requests, results);
  if (!pair) return null;

  const { request, result } = pair;
  const requested_date =
    typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : null;
  const requested_time =
    typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null;

  if (result.status === "denied") {
    return {
      outcome: "denied",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
      allowed_slot_starts: [],
    };
  }

  if (result.status === "failed") {
    if (result.error?.code === "availability_past_date") {
      return {
        outcome: "past_date",
        requested_date,
        requested_time,
        can_present_slots: false,
        required_next_action: "ask_for_future_date",
        allowed_slot_starts: [],
      };
    }
    return {
      outcome: "technical_failure",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
      allowed_slot_starts: [],
    };
  }

  // success
  const allowed_slot_starts = extractAllowedSlotStarts(result);
  if (allowed_slot_starts.length > 0) {
    return {
      outcome: "slots_available",
      requested_date,
      requested_time,
      can_present_slots: true,
      required_next_action: "choose_slot",
      allowed_slot_starts,
    };
  }
  return {
    outcome: "no_slots",
    requested_date,
    requested_time,
    can_present_slots: false,
    required_next_action: "ask_for_alternative_time",
    allowed_slot_starts: [],
  };
}

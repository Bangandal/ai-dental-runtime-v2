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
 * Discriminated union representing the authoritative availability resolution for one turn.
 *
 * attempted=false  → no availability.check request this turn; preserve prior state.
 * attempted=true, pair=null  → request present but call_id missing or unmatched; no slots authorized.
 * attempted=true, pair={...} → exact match; use only this pair.
 */
export type AuthoritativeAvailabilityAttempt =
  | { attempted: false; pair: null }
  | { attempted: true; pair: AuthoritativeAvailabilityPair | null };

/**
 * Resolves the single authoritative availability attempt for the current round.
 *
 * Selection rules:
 *  1. Find the LAST availability.check request by position in requests.
 *  2. If none → attempted=false (prior state preserved downstream).
 *  3. If the last request has no call_id → attempted=true, pair=null (no slot authorization).
 *  4. Find the result whose call_id matches exactly → attempted=true, pair={request, result}.
 *  5. No match found → attempted=true, pair=null.
 *
 * Earlier requests in the same round are superseded by the last one.
 */
export function resolveAuthoritativeAvailabilityAttempt(
  requests: RuntimeAgentToolRequest[],
  results: RuntimeAgentToolResult[],
): AuthoritativeAvailabilityAttempt {
  let lastRequest: RuntimeAgentToolRequest | undefined;
  for (const r of requests) {
    if (r.tool === "availability.check") lastRequest = r;
  }

  if (!lastRequest) return { attempted: false, pair: null };

  if (!lastRequest.call_id) return { attempted: true, pair: null };

  const result = results.find(
    (r) => r.tool === "availability.check" && r.call_id === lastRequest!.call_id,
  );

  if (!result) return { attempted: true, pair: null };

  return { attempted: true, pair: { request: lastRequest, result } };
}

/**
 * Convenience wrapper — returns the pair directly (null when not attempted or when pair is null).
 */
export function findLastAuthoritativeAvailabilityPair(
  requests: RuntimeAgentToolRequest[],
  results: RuntimeAgentToolResult[],
): AuthoritativeAvailabilityPair | null {
  const attempt = resolveAuthoritativeAvailabilityAttempt(requests, results);
  return attempt.attempted ? attempt.pair : null;
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

/**
 * Builds availability action truth from a pre-resolved authoritative attempt.
 *
 * The loop resolves the attempt once and passes it here (and to presentation truth
 * and booking state) so all three consumers share a single authoritative source.
 */
export function buildAvailabilityActionTruth(
  attempt: AuthoritativeAvailabilityAttempt,
): AvailabilityActionTruth | null {
  if (!attempt.attempted || attempt.pair === null) return null;

  const { request, result } = attempt.pair;
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

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
 * attempted=true, pair={...} → exact call_id match; use only this pair.
 *
 * The `request` field is always present when attempted=true so truth builders can read
 * requested_date/requested_time even when the result is absent (e.g. technical_failure).
 */
export type AuthoritativeAvailabilityAttempt =
  | { attempted: false; request: null; pair: null }
  | { attempted: true; request: RuntimeAgentToolRequest; pair: AuthoritativeAvailabilityPair | null };

/**
 * Returns the last availability.check request in `requests`, or undefined if none.
 * Shared by the preflight guard and resolveAuthoritativeAvailabilityAttempt so both
 * use the same last-check-wins selection.
 */
export function findLastAvailabilityRequest(
  requests: RuntimeAgentToolRequest[],
): RuntimeAgentToolRequest | undefined {
  let last: RuntimeAgentToolRequest | undefined;
  for (const r of requests) {
    if (r.tool === "availability.check") last = r;
  }
  return last;
}

/**
 * Resolves the single authoritative availability attempt for the current round.
 *
 * Selection rules (last-check-wins):
 *  1. Find the LAST availability.check request by position in requests.
 *  2. If none → attempted=false (prior state preserved downstream).
 *  3. If the last request has no call_id → attempted=true, request=lastRequest, pair=null.
 *  4. Find the result whose call_id matches exactly → pair={request, result}.
 *  5. No match found → attempted=true, request=lastRequest, pair=null.
 */
export function resolveAuthoritativeAvailabilityAttempt(
  requests: RuntimeAgentToolRequest[],
  results: RuntimeAgentToolResult[],
): AuthoritativeAvailabilityAttempt {
  const lastRequest = findLastAvailabilityRequest(requests);

  if (!lastRequest) return { attempted: false, request: null, pair: null };

  if (!lastRequest.call_id) return { attempted: true, request: lastRequest, pair: null };

  const result = results.find(
    (r) => r.tool === "availability.check" && r.call_id === lastRequest!.call_id,
  );

  if (!result) return { attempted: true, request: lastRequest, pair: null };

  return { attempted: true, request: lastRequest, pair: { request: lastRequest, result } };
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

/**
 * Extracts unique HH:MM slot starts from a tool result. Deduplicates by value.
 * Shared by buildAvailabilityActionTruth and buildAvailabilityPresentationTruth
 * so both surfaces expose identical allowed_slot_starts arrays.
 */
export function extractUniqueAllowedSlotStarts(result: RuntimeAgentToolResult): string[] {
  const data = result.data as { slots?: unknown[] } | null | undefined;
  if (!Array.isArray(data?.slots)) return [];
  const seen = new Set<string>();
  const starts: string[] = [];
  for (const s of data!.slots!) {
    if (s && typeof s === "object") {
      const raw = s as { starts_at?: unknown };
      const hhmm = extractSlotHHMM(raw.starts_at);
      if (hhmm !== null && !seen.has(hhmm)) {
        seen.add(hhmm);
        starts.push(hhmm);
      }
    }
  }
  return starts;
}

/**
 * Builds availability action truth from a pre-resolved authoritative attempt.
 *
 * Returns null only when attempted=false (no availability.check this turn).
 * When attempted=true and pair=null (missing/unmatched call_id), returns
 * a technical_failure truth with can_present_slots=false so the model cannot
 * present slots from raw tool_results.
 */
export function buildAvailabilityActionTruth(
  attempt: AuthoritativeAvailabilityAttempt,
): AvailabilityActionTruth | null {
  if (!attempt.attempted) return null;

  const { request, pair } = attempt;
  const requested_date =
    typeof request.arguments.requested_date === "string" ? request.arguments.requested_date : null;
  const requested_time =
    typeof request.arguments.requested_time === "string" ? request.arguments.requested_time : null;

  if (pair === null) {
    return {
      outcome: "technical_failure",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
      allowed_slot_starts: [],
    };
  }

  const { result } = pair;

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
  const allowed_slot_starts = extractUniqueAllowedSlotStarts(result);
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

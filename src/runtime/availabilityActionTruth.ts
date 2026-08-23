import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";

export type AvailabilityOutcome =
  | "slots_available"
  | "no_slots"
  | "needs_date"
  | "past_date"
  | "technical_failure"
  | "denied";

export type AvailabilityRequiredNextAction =
  | "choose_slot"
  | "ask_for_alternative_time"
  | "ask_for_date"
  | "ask_for_future_date"
  | "retry_or_contact_clinic";

export type AvailabilityWeekdayCode =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface AvailabilityActionTruth {
  outcome: AvailabilityOutcome;
  requested_date: string | null;
  requested_weekday: AvailabilityWeekdayCode | null;
  requested_time: string | null;
  /** Date the successful slot payload actually belongs to. May differ after auto-extension. */
  resolved_date: string | null;
  resolved_weekday: AvailabilityWeekdayCode | null;
  /** Set only when Runtime searched forward from the requested date. */
  nearest_available_date: string | null;
  can_present_slots: boolean;
  required_next_action: AvailabilityRequiredNextAction;
  /** HH:MM values only — same format as availability_presentation_truth.allowed_slot_starts. */
  allowed_slot_starts: string[];
}

/** Strict YYYY-MM-DD date extraction from starts_at. */
export function extractSlotDate(startsAt: unknown): string | null {
  if (typeof startsAt !== "string") return null;
  const match = startsAt.match(/^(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : null;
}

/** Extracts HH:MM from an ISO starts_at string or a bare "HH:MM" string. */
export function extractSlotHHMM(startsAt: unknown): string | null {
  if (typeof startsAt !== "string") return null;
  const iso = startsAt.match(/T(\d{2}:\d{2})(?::\d{2})?/);
  if (iso) return iso[1];
  const bare = startsAt.match(/^(\d{2}:\d{2})$/);
  return bare ? bare[1] : null;
}

/**
 * Language-neutral calendar truth for an ISO date. Returns null for malformed or
 * impossible dates so Runtime never gives the model an invented weekday.
 */
export function getAvailabilityWeekdayCode(date: string | null): AvailabilityWeekdayCode | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  const day = parsed.getUTCDay();
  const codes: AvailabilityWeekdayCode[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return codes[day] ?? null;
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

function resolveSuccessfulAvailabilityDate(
  result: RuntimeAgentToolResult,
  requestedDate: string | null,
): { resolved_date: string | null; nearest_available_date: string | null } {
  const data = result.data as { slots?: unknown[]; nearest_available_date?: unknown } | null | undefined;
  const nearest = typeof data?.nearest_available_date === "string" ? data.nearest_available_date : null;
  if (nearest !== null) {
    return { resolved_date: nearest, nearest_available_date: nearest };
  }

  if (Array.isArray(data?.slots)) {
    for (const slot of data.slots) {
      if (!slot || typeof slot !== "object") continue;
      const startsAt = (slot as { starts_at?: unknown }).starts_at;
      const slotDate = extractSlotDate(startsAt);
      if (slotDate !== null) {
        return { resolved_date: slotDate, nearest_available_date: null };
      }
    }
  }

  // Successful empty result is still authoritative negative truth for the requested date.
  return { resolved_date: requestedDate, nearest_available_date: null };
}

function baseTruth(params: {
  outcome: AvailabilityOutcome;
  requested_date: string | null;
  requested_time: string | null;
  resolved_date?: string | null;
  nearest_available_date?: string | null;
  can_present_slots: boolean;
  required_next_action: AvailabilityRequiredNextAction;
  allowed_slot_starts?: string[];
}): AvailabilityActionTruth {
  const resolvedDate = params.resolved_date ?? null;
  return {
    outcome: params.outcome,
    requested_date: params.requested_date,
    requested_weekday: getAvailabilityWeekdayCode(params.requested_date),
    requested_time: params.requested_time,
    resolved_date: resolvedDate,
    resolved_weekday: getAvailabilityWeekdayCode(resolvedDate),
    nearest_available_date: params.nearest_available_date ?? null,
    can_present_slots: params.can_present_slots,
    required_next_action: params.required_next_action,
    allowed_slot_starts: params.allowed_slot_starts ?? [],
  };
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
    return baseTruth({
      outcome: "technical_failure",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
    });
  }

  const { result } = pair;

  if (result.status === "denied") {
    return baseTruth({
      outcome: "denied",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
    });
  }

  if (result.status === "failed") {
    if (
      result.error?.code === "availability_missing_requested_date" ||
      result.error?.code === "availability_invalid_requested_date"
    ) {
      return baseTruth({
        outcome: "needs_date",
        requested_date,
        requested_time,
        can_present_slots: false,
        required_next_action: "ask_for_date",
      });
    }
    if (result.error?.code === "availability_past_date") {
      return baseTruth({
        outcome: "past_date",
        requested_date,
        requested_time,
        can_present_slots: false,
        required_next_action: "ask_for_future_date",
      });
    }
    return baseTruth({
      outcome: "technical_failure",
      requested_date,
      requested_time,
      can_present_slots: false,
      required_next_action: "retry_or_contact_clinic",
    });
  }

  // success
  const allowed_slot_starts = extractUniqueAllowedSlotStarts(result);
  const dates = resolveSuccessfulAvailabilityDate(result, requested_date);
  if (allowed_slot_starts.length > 0) {
    return baseTruth({
      outcome: "slots_available",
      requested_date,
      requested_time,
      resolved_date: dates.resolved_date,
      nearest_available_date: dates.nearest_available_date,
      can_present_slots: true,
      required_next_action: "choose_slot",
      allowed_slot_starts,
    });
  }
  return baseTruth({
    outcome: "no_slots",
    requested_date,
    requested_time,
    resolved_date: dates.resolved_date,
    nearest_available_date: dates.nearest_available_date,
    can_present_slots: false,
    required_next_action: "ask_for_alternative_time",
  });
}

import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import type { AuthoritativeAvailabilityAttempt } from "./availabilityActionTruth.ts";

export interface AvailabilityEvidence {
  availability_call_id: string;
  requested_date: string;
  requested_time: string | null;
  /** Unique YYYY-MM-DDTHH:MM keys from the authoritative successful availability.check result. */
  allowed_slot_keys: string[];
}

export interface SelectedSlotProof {
  availability_call_id: string;
  /** Canonical YYYY-MM-DDTHH:MM key matching the selected slot. */
  slot_key: string;
}

/**
 * Normalizes a date + time pair to the canonical slot key format YYYY-MM-DDTHH:MM.
 * Accepts HH:MM or HH:MM:SS for time. Returns null for invalid or incomplete inputs.
 */
export function normalizeSlotKey(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  const timeMatch = time.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!timeMatch) return null;
  const h = parseInt(timeMatch[1], 10);
  const m = parseInt(timeMatch[2], 10);
  if (h > 23 || m > 59) return null;
  return `${date.trim()}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Converts a slot's starts_at ISO datetime to a canonical YYYY-MM-DDTHH:MM key.
 * Returns null when the string is absent or not a valid ISO datetime.
 */
export function slotToKey(slot: { starts_at: string }): string | null {
  const raw = slot.starts_at;
  if (!raw) return null;
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?/);
  if (!isoMatch) return null;
  return normalizeSlotKey(isoMatch[1], isoMatch[2]);
}

/**
 * Extracts unique canonical YYYY-MM-DDTHH:MM keys from a successful availability.check result.
 * Malformed starts_at values are silently ignored.
 */
export function buildAllowedSlotKeysFromResult(result: RuntimeAgentToolResult): string[] {
  const data = result.data as { slots?: Array<{ starts_at?: string }> } | null | undefined;
  if (!Array.isArray(data?.slots)) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const s of data!.slots!) {
    if (s && typeof s.starts_at === "string") {
      const key = slotToKey({ starts_at: s.starts_at });
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

export type BookingSlotEvidenceResult =
  | {
      ok: true;
      source: "current_turn_availability" | "persisted_selected_slot";
      slot_key: string;
      availability_call_id: string;
    }
  | {
      ok: false;
      reason:
        | "missing_booking_slot"
        | "no_authoritative_availability_evidence"
        | "slot_not_in_authoritative_evidence"
        | "selected_slot_proof_missing"
        | "selected_slot_proof_mismatch";
    };

/**
 * Validates that a booking.apply request can be traced to authoritative availability evidence.
 *
 * Two proof paths — checked in order:
 *
 * 1. Current-turn: if this turn's authoritative availability.check succeeded and the
 *    requested slot key exists in that result, booking may proceed immediately (supports
 *    avail.check → second-model-call → booking.apply in one turn).
 *
 * 2. Persisted: a prior turn's active_availability_evidence + selected_slot +
 *    selected_slot_proof must all agree on the same slot key and call ID.
 *
 * Explicitly rejected:
 *   - last_available_slots without evidence metadata
 *   - selected_slot without selected_slot_proof
 *   - proof whose call ID differs from active evidence
 *   - a different date with the same HH:MM
 *   - an earlier superseded result from the same round
 */
export function validateBookingSlotEvidence(params: {
  bookingApplyRequest: RuntimeAgentToolRequest;
  currentAvailabilityAttempt: AuthoritativeAvailabilityAttempt;
  activeAvailabilityEvidence: AvailabilityEvidence | null | undefined;
  selectedSlot: { starts_at: string } | null | undefined;
  selectedSlotProof: SelectedSlotProof | null | undefined;
}): BookingSlotEvidenceResult {
  const {
    bookingApplyRequest,
    currentAvailabilityAttempt,
    activeAvailabilityEvidence,
    selectedSlot,
    selectedSlotProof,
  } = params;

  const requestedDate =
    typeof bookingApplyRequest.arguments.requested_date === "string"
      ? bookingApplyRequest.arguments.requested_date.trim()
      : null;
  const requestedTime =
    typeof bookingApplyRequest.arguments.requested_time === "string"
      ? bookingApplyRequest.arguments.requested_time.trim()
      : null;

  if (!requestedDate || !requestedTime) return { ok: false, reason: "missing_booking_slot" };
  const requestedKey = normalizeSlotKey(requestedDate, requestedTime);
  if (!requestedKey) return { ok: false, reason: "missing_booking_slot" };

  // Path 1: current-turn authoritative availability
  if (
    currentAvailabilityAttempt.attempted &&
    currentAvailabilityAttempt.pair !== null &&
    currentAvailabilityAttempt.pair.result.status === "success" &&
    currentAvailabilityAttempt.pair.request.call_id
  ) {
    const callId = currentAvailabilityAttempt.pair.request.call_id;
    const allowedKeys = buildAllowedSlotKeysFromResult(currentAvailabilityAttempt.pair.result);
    if (allowedKeys.includes(requestedKey)) {
      return { ok: true, source: "current_turn_availability", slot_key: requestedKey, availability_call_id: callId };
    }
    return { ok: false, reason: "slot_not_in_authoritative_evidence" };
  }

  // Path 2: persisted proof
  if (!activeAvailabilityEvidence) {
    return { ok: false, reason: "no_authoritative_availability_evidence" };
  }

  if (!selectedSlot || !selectedSlotProof) {
    return { ok: false, reason: "selected_slot_proof_missing" };
  }

  const selectedKey = slotToKey(selectedSlot);
  if (!selectedKey || selectedKey !== requestedKey) {
    return { ok: false, reason: "selected_slot_proof_mismatch" };
  }

  if (selectedSlotProof.slot_key !== requestedKey) {
    return { ok: false, reason: "selected_slot_proof_mismatch" };
  }

  if (selectedSlotProof.availability_call_id !== activeAvailabilityEvidence.availability_call_id) {
    return { ok: false, reason: "selected_slot_proof_mismatch" };
  }

  if (!activeAvailabilityEvidence.allowed_slot_keys.includes(selectedSlotProof.slot_key)) {
    return { ok: false, reason: "slot_not_in_authoritative_evidence" };
  }

  return {
    ok: true,
    source: "persisted_selected_slot",
    slot_key: requestedKey,
    availability_call_id: selectedSlotProof.availability_call_id,
  };
}

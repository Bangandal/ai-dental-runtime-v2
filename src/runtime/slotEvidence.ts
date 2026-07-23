import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import { parseSubjectId, type SubjectId } from "./bookingSubjectsState.ts";

export interface AvailabilityEvidence {
  availability_call_id: string;
  requested_date: string;
  requested_time: string | null;
  /** Unique YYYY-MM-DDTHH:MM keys from the authoritative successful availability.check result. */
  allowed_slot_keys: string[];
}

export interface SelectedSlotProof {
  /** Subject this proof was created for. Absent in legacy proofs — treated as stale. */
  subject_id?: SubjectId | null;
  availability_call_id: string;
  /** Canonical YYYY-MM-DDTHH:MM key matching the selected slot. */
  slot_key: string;
}

/**
 * Normalizes a date + time pair to the canonical slot key format YYYY-MM-DDTHH:MM.
 * Accepts HH:MM or HH:MM:SS for time, and single-digit hours. Returns null for invalid inputs.
 * Used for parsing structured availability slots (slotToKey). NOT for booking request validation.
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

function isValidCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, mo, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isStrictHHMM(time: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(":").map(Number);
  return h <= 23 && m <= 59;
}

/**
 * Strict booking-request key: requires exactly YYYY-MM-DD (valid calendar date) and HH:MM
 * (two-digit hour, no seconds). Rejects "9:00", "09:00:00", "2027-02-31", etc.
 * Use this for validating patient booking requests — not for parsing availability slots.
 */
export function normalizeBookingRequestKey(date: string, time: string): string | null {
  const d = date.trim();
  const t = time.trim();
  if (!isValidCalendarDate(d)) return null;
  if (!isStrictHHMM(t)) return null;
  return `${d}T${t}`;
}

export type BookingSlotFormatResult =
  | { ok: true; slot_key: string }
  | { ok: false; reason: "missing_booking_slot" | "invalid_booking_slot_format" };

/**
 * Validates that a booking.apply request includes a strictly-formatted date (YYYY-MM-DD,
 * valid calendar) and time (HH:MM exact, two-digit hour). Single-digit hours, seconds
 * suffixes, and impossible calendar dates are all rejected as invalid_booking_slot_format.
 * This is the single source of truth for format validation — guards must not duplicate it.
 */
export function validateBookingRequestFormat(
  args: Record<string, unknown>,
): BookingSlotFormatResult {
  const date = typeof args.requested_date === "string" ? args.requested_date.trim() : null;
  const time = typeof args.requested_time === "string" ? args.requested_time.trim() : null;
  if (!date || !time) return { ok: false, reason: "missing_booking_slot" };
  const key = normalizeBookingRequestKey(date, time);
  if (!key) return { ok: false, reason: "invalid_booking_slot_format" };
  return { ok: true, slot_key: key };
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
      source: "persisted_selected_slot";
      slot_key: string;
      availability_call_id: string;
    }
  | {
      ok: false;
      reason:
        | "missing_booking_slot"
        | "invalid_booking_slot_format"
        | "no_authoritative_availability_evidence"
        | "slot_not_in_authoritative_evidence"
        | "selected_slot_proof_missing"
        | "selected_slot_proof_mismatch";
    };

/**
 * Validates that a booking.apply request can be traced to a complete selected-slot proof chain.
 *
 * Required chain (all 8 checks):
 *   1. active availability evidence exists
 *   2. selected slot exists
 *   3. selected-slot proof exists
 *   3a. proof has subject_id (legacy proofs without it are treated as stale)
 *   4. requested booking slot equals selected slot
 *   5. proof slot key equals requested slot
 *   6. proof availability call ID equals active evidence call ID
 *   7. slot exists in active evidence allowed_slot_keys
 *   8. proof subject equals booking.apply subject
 *
 * A successful availability.check alone never authorizes booking.apply.
 * The structured booking.select_slot tool must be called first to create the proof.
 */
export function validateBookingSlotEvidence(params: {
  bookingApplyRequest: RuntimeAgentToolRequest;
  activeAvailabilityEvidence: AvailabilityEvidence | null | undefined;
  selectedSlot: { starts_at: string } | null | undefined;
  selectedSlotProof: SelectedSlotProof | null | undefined;
}): BookingSlotEvidenceResult {
  const {
    bookingApplyRequest,
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
  const requestedKey = normalizeBookingRequestKey(requestedDate, requestedTime);
  if (!requestedKey) return { ok: false, reason: "invalid_booking_slot_format" };

  // Check 1: active availability evidence
  if (!activeAvailabilityEvidence) {
    return { ok: false, reason: "no_authoritative_availability_evidence" };
  }

  // Checks 2+3: selected slot and proof must exist
  if (!selectedSlot || !selectedSlotProof) {
    return { ok: false, reason: "selected_slot_proof_missing" };
  }

  // Check 3a: legacy proof without subject_id is treated as stale
  if (!selectedSlotProof.subject_id) {
    return { ok: false, reason: "selected_slot_proof_missing" };
  }

  // Check 4: selected slot key matches requested booking slot
  const selectedKey = slotToKey(selectedSlot);
  if (!selectedKey || selectedKey !== requestedKey) {
    return { ok: false, reason: "selected_slot_proof_mismatch" };
  }

  // Check 5: proof slot key matches requested slot
  if (selectedSlotProof.slot_key !== requestedKey) {
    return { ok: false, reason: "selected_slot_proof_mismatch" };
  }

  // Check 6: proof availability call ID matches active evidence call ID
  if (selectedSlotProof.availability_call_id !== activeAvailabilityEvidence.availability_call_id) {
    return { ok: false, reason: "selected_slot_proof_mismatch" };
  }

  // Check 7: slot key exists in active evidence
  if (!activeAvailabilityEvidence.allowed_slot_keys.includes(selectedSlotProof.slot_key)) {
    return { ok: false, reason: "slot_not_in_authoritative_evidence" };
  }

  // Check 8: proof subject matches booking.apply subject
  const bookingApplySubjectId = parseSubjectId(bookingApplyRequest.arguments.subject_id);
  if (!bookingApplySubjectId || selectedSlotProof.subject_id !== bookingApplySubjectId) {
    return { ok: false, reason: "selected_slot_proof_mismatch" };
  }

  return {
    ok: true,
    source: "persisted_selected_slot",
    slot_key: requestedKey,
    availability_call_id: selectedSlotProof.availability_call_id,
  };
}

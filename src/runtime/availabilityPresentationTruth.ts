import { type AuthoritativeAvailabilityAttempt, extractUniqueAllowedSlotStarts } from "./availabilityActionTruth.ts";

export interface AvailabilityPresentationTruth {
  must_list_exact_slots_only: true;
  must_not_summarize_ranges: true;
  max_slots_to_present: 5;
  /** HH:MM values only — same format as availability_action_truth.allowed_slot_starts. */
  allowed_slot_starts: string[];
}

/**
 * Derives presentation truth from the pre-resolved authoritative availability attempt.
 *
 * Returns null when:
 *   - attempted=false (no availability.check this turn)
 *   - pair=null (missing or unmatched call_id — no result is authorized)
 *   - authoritative result is not a success
 *   - authoritative success result has zero unique slots
 */
export function buildAvailabilityPresentationTruth(
  attempt: AuthoritativeAvailabilityAttempt,
): AvailabilityPresentationTruth | null {
  if (!attempt.attempted || attempt.pair === null) return null;
  if (attempt.pair.result.status !== "success") return null;

  const allowedSlotStarts = extractUniqueAllowedSlotStarts(attempt.pair.result);
  if (allowedSlotStarts.length === 0) return null;

  return {
    must_list_exact_slots_only: true,
    must_not_summarize_ranges: true,
    max_slots_to_present: 5,
    allowed_slot_starts: allowedSlotStarts,
  };
}

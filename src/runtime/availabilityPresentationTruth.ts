import { type AuthoritativeAvailabilityAttempt, extractSlotHHMM } from "./availabilityActionTruth.ts";

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
 * The loop resolves the attempt once and passes it here (and to action truth and booking state)
 * so all three consumers share a single authoritative source.
 *
 * Returns null when:
 *   - attempted=false (no availability.check this turn)
 *   - pair=null (missing or unmatched call_id)
 *   - authoritative result is not a success
 *   - authoritative success result has zero slots
 */
export function buildAvailabilityPresentationTruth(
  attempt: AuthoritativeAvailabilityAttempt,
): AvailabilityPresentationTruth | null {
  if (!attempt.attempted || attempt.pair === null) return null;
  if (attempt.pair.result.status !== "success") return null;

  const data = attempt.pair.result.data as { slots?: unknown[] } | undefined;
  if (!data || !Array.isArray(data.slots) || data.slots.length === 0) return null;

  const allowedSlotStarts: string[] = [];
  for (const slot of data.slots) {
    if (slot !== null && typeof slot === "object") {
      const s = slot as { starts_at?: unknown };
      const hhmm = extractSlotHHMM(s.starts_at);
      if (hhmm !== null && !allowedSlotStarts.includes(hhmm)) {
        allowedSlotStarts.push(hhmm);
      }
    }
  }

  if (allowedSlotStarts.length === 0) return null;

  return {
    must_list_exact_slots_only: true,
    must_not_summarize_ranges: true,
    max_slots_to_present: 5,
    allowed_slot_starts: allowedSlotStarts,
  };
}

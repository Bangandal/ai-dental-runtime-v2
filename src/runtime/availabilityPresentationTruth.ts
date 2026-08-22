import {
  type AuthoritativeAvailabilityAttempt,
  type AvailabilityWeekdayCode,
  extractSlotDate,
  extractSlotHHMM,
  getAvailabilityWeekdayCode,
} from "./availabilityActionTruth.ts";

export interface AvailabilityPresentationSlotTruth {
  date: string;
  weekday: AvailabilityWeekdayCode;
  time: string;
  starts_at: string;
  ends_at: string | null;
}

export interface AvailabilityPresentationTruth {
  must_list_exact_slots_only: true;
  must_not_summarize_ranges: true;
  max_slots_to_present: 5;
  /** The authoritative date these presented slots belong to. */
  resolved_date: string;
  resolved_weekday: AvailabilityWeekdayCode;
  timezone: string | null;
  /** Exact date+time facts safe for patient-facing presentation. */
  allowed_slots: AvailabilityPresentationSlotTruth[];
  /** Compatibility field: HH:MM values for the same resolved_date only. */
  allowed_slot_starts: string[];
}

/**
 * Derives presentation truth from the pre-resolved authoritative availability attempt.
 *
 * Returns null when:
 *   - attempted=false (no availability.check this turn)
 *   - pair=null (missing or unmatched call_id — no result is authorized)
 *   - authoritative result is not a success
 *   - authoritative success result has zero valid slots
 *   - the returned date cannot be proven from nearest_available_date or slot starts_at
 *
 * When auto-extension returns another day, only slots from that resolved day are exposed.
 * This prevents the model from combining the requested date with times that actually belong
 * to a later working day.
 */
export function buildAvailabilityPresentationTruth(
  attempt: AuthoritativeAvailabilityAttempt,
): AvailabilityPresentationTruth | null {
  if (!attempt.attempted || attempt.pair === null) return null;
  if (attempt.pair.result.status !== "success") return null;

  const data = attempt.pair.result.data as {
    slots?: unknown[];
    nearest_available_date?: unknown;
    timezone?: unknown;
  } | null | undefined;
  if (!Array.isArray(data?.slots) || data.slots.length === 0) return null;

  const nearestAvailableDate = typeof data.nearest_available_date === "string"
    ? data.nearest_available_date
    : null;

  let firstSlotDate: string | null = null;
  for (const slot of data.slots) {
    if (!slot || typeof slot !== "object") continue;
    firstSlotDate = extractSlotDate((slot as { starts_at?: unknown }).starts_at);
    if (firstSlotDate !== null) break;
  }

  const resolvedDate = nearestAvailableDate ?? firstSlotDate;
  const resolvedWeekday = getAvailabilityWeekdayCode(resolvedDate);
  if (resolvedDate === null || resolvedWeekday === null) return null;

  const seen = new Set<string>();
  const allowedSlots: AvailabilityPresentationSlotTruth[] = [];

  for (const slot of data.slots) {
    if (!slot || typeof slot !== "object") continue;
    const raw = slot as { starts_at?: unknown; ends_at?: unknown };
    if (typeof raw.starts_at !== "string") continue;

    const date = extractSlotDate(raw.starts_at);
    const time = extractSlotHHMM(raw.starts_at);
    if (date !== resolvedDate || time === null) continue;

    const key = `${date}T${time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    allowedSlots.push({
      date,
      weekday: resolvedWeekday,
      time,
      starts_at: raw.starts_at,
      ends_at: typeof raw.ends_at === "string" ? raw.ends_at : null,
    });
  }

  if (allowedSlots.length === 0) return null;

  return {
    must_list_exact_slots_only: true,
    must_not_summarize_ranges: true,
    max_slots_to_present: 5,
    resolved_date: resolvedDate,
    resolved_weekday: resolvedWeekday,
    timezone: typeof data.timezone === "string" ? data.timezone : null,
    allowed_slots: allowedSlots,
    allowed_slot_starts: allowedSlots.map((slot) => slot.time),
  };
}

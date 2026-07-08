/**
 * Extracts a phone number from free text typed by the patient.
 *
 * Used when the patient types a phone number as text instead of (or in
 * addition to) sharing via Telegram contact button — most commonly when
 * booking an appointment for someone else.
 *
 * Returns the phone number with all non-digit characters stripped except for
 * a leading "+" (if present in the original). Returns null if no phone-like
 * sequence (9–15 digits) is found.
 *
 * False-positive avoidance:
 *  - Requires at least 9 consecutive digits (rules out dates, short IDs).
 *  - Caps at 15 digits (E.164 max length).
 *  - Allows internal spaces/dashes as separators (e.g. "728 945 521").
 */
export function extractTypedPhone(text: string): string | null {
  // Match sequences: optional leading +, then digits optionally separated by
  // spaces or dashes, totalling 9–15 digits.
  const pattern = /(\+?[\d][\d\s\-]{6,}[\d])/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15) {
      // Preserve leading + if present, strip all other non-digit chars.
      const hasPlus = raw.trimStart().startsWith("+");
      return (hasPlus ? "+" : "") + digits;
    }
  }
  return null;
}

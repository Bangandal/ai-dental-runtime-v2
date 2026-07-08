/**
 * Extracts a phone number typed by the patient in free-form text.
 * Returns a normalized string (digits only, with leading + if present), or null.
 * Only accepts sequences that look like real phone numbers: 9-15 digits.
 */
export function extractTypedPhone(text: string): string | null {
  const pattern = /(\+?[\d][\d\s\-]{6,}[\d])/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15) {
      const hasPlus = raw.trimStart().startsWith("+");
      return (hasPlus ? "+" : "") + digits;
    }
  }
  return null;
}

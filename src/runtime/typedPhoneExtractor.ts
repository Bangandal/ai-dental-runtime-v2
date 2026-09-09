/**
 * Deterministic current-turn phone extraction.
 *
 * A phone number is transport/contact data, not a semantic decision. Runtime may normalize
 * an explicit 9-15 digit phone-shaped token from the current patient message in every mode.
 * The extracted value is still recorded as source=typed, trust=unverified and never promoted
 * to a trusted channel contact. Ownership and patient identity remain separate deterministic
 * guards. In agent-first the model may also provide booking.apply.phone_number; this extractor
 * is the fallback when the model omits that field.
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

import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";

/**
 * Legacy free-text phone extraction.
 *
 * Agent-first deliberately disables this parser: the model owns understanding and
 * normalization and passes phone_number through booking.apply. Keeping this function only
 * for legacy mode makes the architecture boundary explicit while preserving rollback.
 */
export function extractTypedPhone(text: string): string | null {
  if (isAgentFirstRuntimeEnabled()) return null;

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

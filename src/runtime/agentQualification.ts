export interface AgentQualificationState {
  /** Patient-described problem in the model's concise words. Not a diagnosis. */
  complaint?: string;
  /** Facts explicitly reported by the patient, kept as short natural-language items. */
  reported_facts?: string[];
  /** Compact admin-facing summary of the information gathered so far. */
  summary?: string;
  /** Clinic-policy-derived routing fields. These are stripped unless trusted policy exists in model context. */
  route?: string;
  urgency?: string;
  red_flags?: string[];
  policy_applied?: boolean;
}

declare module "./openaiRuntimeAgent.ts" {
  interface RuntimeAgentFinalResponse {
    qualification?: AgentQualificationState | null;
  }
  interface RuntimeAgentTurnResult {
    qualification?: AgentQualificationState | null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanString(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

function cleanStringArray(value: unknown, maxItems = 12, maxChars = 300): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, maxChars))
    .filter((item): item is string => item !== null)
    .slice(0, maxItems);
}

/**
 * Clinical routing may only be accepted when Runtime has actually supplied a clinic-owned
 * qualification policy to the model. Mere conversation history or model confidence is not
 * authority. The current production context has no such policy, so routing fields fail closed.
 */
export function hasTrustedQualificationPolicy(modelContext: Record<string, unknown> | null): boolean {
  if (!modelContext) return false;
  const runtimeContext = asRecord(modelContext.runtime_context);
  const policy = asRecord(runtimeContext?.qualification_policy);
  if (!policy) return false;
  return policy.enabled === true && typeof policy.source === "string" && policy.source.trim().length > 0;
}

/**
 * Parse the qualification object produced by the main patient agent.
 *
 * Patient-reported observations are safe to retain without clinical policy because they are
 * notes, not medical decisions. route/urgency/red_flags are authority-sensitive and are
 * discarded unless a trusted clinic qualification policy is present in Runtime context.
 */
export function parseAgentQualification(
  raw: unknown,
  modelContext: Record<string, unknown> | null,
): AgentQualificationState | null {
  const record = asRecord(raw);
  if (!record) return null;

  const complaint = cleanString(record.complaint, 500);
  const reportedFacts = cleanStringArray(record.reported_facts, 12, 300);
  const summary = cleanString(record.summary, 1000);
  const trustedPolicy = hasTrustedQualificationPolicy(modelContext);

  const route = trustedPolicy ? cleanString(record.route, 200) : null;
  const urgency = trustedPolicy ? cleanString(record.urgency, 100) : null;
  const redFlags = trustedPolicy ? cleanStringArray(record.red_flags, 12, 200) : [];

  const parsed: AgentQualificationState = {
    ...(complaint ? { complaint } : {}),
    ...(reportedFacts.length > 0 ? { reported_facts: reportedFacts } : {}),
    ...(summary ? { summary } : {}),
    ...(route ? { route } : {}),
    ...(urgency ? { urgency } : {}),
    ...(redFlags.length > 0 ? { red_flags: redFlags } : {}),
    ...(trustedPolicy ? { policy_applied: true } : {}),
  };

  return Object.keys(parsed).length > 0 ? parsed : null;
}

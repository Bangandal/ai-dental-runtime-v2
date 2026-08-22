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

function mergeUniqueStrings(
  previous: string[] | undefined,
  next: string[] | undefined,
  maxItems: number,
): string[] | undefined {
  const merged = [...(previous ?? []), ...(next ?? [])]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(-maxItems);
  return merged.length > 0 ? merged : undefined;
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

/**
 * Merge a validated per-turn qualification update into durable state.
 * Runtime, not the model, owns accumulation across turns.
 */
export function mergeAgentQualification(
  previous: AgentQualificationState | null | undefined,
  next: AgentQualificationState | null | undefined,
): AgentQualificationState | null {
  if (!previous && !next) return null;
  if (!previous) return next ?? null;
  if (!next) return previous;

  const reportedFacts = mergeUniqueStrings(previous.reported_facts, next.reported_facts, 24);
  const redFlags = mergeUniqueStrings(previous.red_flags, next.red_flags, 12);
  const merged: AgentQualificationState = {
    ...(next.complaint ?? previous.complaint ? { complaint: next.complaint ?? previous.complaint } : {}),
    ...(reportedFacts ? { reported_facts: reportedFacts } : {}),
    ...(next.summary ?? previous.summary ? { summary: next.summary ?? previous.summary } : {}),
    ...(next.route ?? previous.route ? { route: next.route ?? previous.route } : {}),
    ...(next.urgency ?? previous.urgency ? { urgency: next.urgency ?? previous.urgency } : {}),
    ...(redFlags ? { red_flags: redFlags } : {}),
    ...((next.policy_applied ?? previous.policy_applied) ? { policy_applied: true } : {}),
  };

  return Object.keys(merged).length > 0 ? merged : null;
}

/** Read previously validated qualification stored under collected.agent_qualification. */
export function parseStoredAgentQualification(raw: unknown): AgentQualificationState | null {
  const record = asRecord(raw);
  if (!record) return null;
  const complaint = cleanString(record.complaint, 500);
  const reportedFacts = cleanStringArray(record.reported_facts, 24, 300);
  const summary = cleanString(record.summary, 1000);
  const route = cleanString(record.route, 200);
  const urgency = cleanString(record.urgency, 100);
  const redFlags = cleanStringArray(record.red_flags, 12, 200);

  const parsed: AgentQualificationState = {
    ...(complaint ? { complaint } : {}),
    ...(reportedFacts.length > 0 ? { reported_facts: reportedFacts } : {}),
    ...(summary ? { summary } : {}),
    ...(route ? { route } : {}),
    ...(urgency ? { urgency } : {}),
    ...(redFlags.length > 0 ? { red_flags: redFlags } : {}),
    ...(record.policy_applied === true ? { policy_applied: true } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : null;
}

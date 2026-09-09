import { parseStoredAgentQualification } from "./agentQualification.ts";
import { parseStaffRequest } from "./staffRequest.ts";

const MAX_RECENT_HISTORY_MESSAGES = 8;
const MAX_RECENT_HISTORY_CHARS = 2000;
const DEFAULT_SEMANTIC_CONTEXT_TTL_HOURS = 24;

type UnknownRecord = Record<string, unknown>;
type NormalizedHistoryItem = { role: string; text: string; created_at: string | null };

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function resolveSemanticContextTtlMs(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const configured = Number(env.RUNTIME_SEMANTIC_CONTEXT_TTL_HOURS);
  const hours = Number.isFinite(configured) && configured >= 1 && configured <= 168
    ? configured
    : DEFAULT_SEMANTIC_CONTEXT_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

export function isSemanticContextFresh(
  updatedAt: string | null,
  now = new Date(),
  ttlMs = resolveSemanticContextTtlMs(),
): boolean {
  if (!updatedAt) return true;
  const parsed = new Date(updatedAt).getTime();
  if (!Number.isFinite(parsed)) return true;
  const age = now.getTime() - parsed;
  return age >= 0 && age <= ttlMs;
}

function normalizeHistory(raw: unknown[]): NormalizedHistoryItem[] {
  const normalized: NormalizedHistoryItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const msg = item as Record<string, unknown>;
    const role = asNullableString(msg.role);
    const text = asNullableString(msg.text) ?? asNullableString(msg.content);
    if (!role || !text) continue;
    normalized.push({ role, text, created_at: asNullableString(msg.created_at) });
  }
  return normalized;
}

function capHistory(items: NormalizedHistoryItem[]): Array<{ role: string; text: string }> {
  const sliced = items.slice(-MAX_RECENT_HISTORY_MESSAGES);
  let totalChars = sliced.reduce((sum, item) => sum + item.text.length, 0);
  let start = 0;
  while (totalChars > MAX_RECENT_HISTORY_CHARS && start < sliced.length) {
    totalChars -= sliced[start].text.length;
    start += 1;
  }
  return sliced.slice(start).map(({ role, text }) => ({ role, text }));
}

function findSessionStartIndex(items: NormalizedHistoryItem[], ttlMs: number): number {
  if (items.length <= 1) return 0;
  let sessionStart = 0;
  for (let index = 1; index < items.length; index += 1) {
    const previousAt = items[index - 1].created_at;
    const currentAt = items[index].created_at;
    if (!previousAt || !currentAt) continue;
    const previousMs = new Date(previousAt).getTime();
    const currentMs = new Date(currentAt).getTime();
    if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) continue;
    if (currentMs - previousMs > ttlMs) sessionStart = index;
  }
  return sessionStart;
}

export function getSemanticSessionStartedAt(
  raw: unknown[],
  ttlMs = resolveSemanticContextTtlMs(),
): string | null {
  const normalized = normalizeHistory(raw);
  if (normalized.length === 0) return null;
  return normalized.slice(findSessionStartIndex(normalized, ttlMs))[0]?.created_at ?? null;
}

export function isStoredSemanticItemInCurrentSession(
  itemUpdatedAt: unknown,
  sessionStartedAt: string | null,
): boolean {
  if (!sessionStartedAt) return true;
  const itemAt = asNullableString(itemUpdatedAt);
  if (!itemAt) return false;
  const itemMs = new Date(itemAt).getTime();
  const sessionMs = new Date(sessionStartedAt).getTime();
  return Number.isFinite(itemMs) && Number.isFinite(sessionMs) && itemMs >= sessionMs;
}

export function assembleRecentHistory(raw: unknown[]): Array<{ role: string; text: string }> {
  const normalized = normalizeHistory(raw);
  return capHistory(normalized.slice(findSessionStartIndex(normalized, resolveSemanticContextTtlMs())));
}

/**
 * Only session-scoped patient evidence is model-visible. Old unversioned slot/intake/case
 * state never becomes model authority.
 */
export function buildModelVisibleRuntimeContext(runtimeContext: unknown): Record<string, unknown> {
  const context = asRecord(runtimeContext);
  const knownContact = asRecord(context.known_contact);
  const conversationState = asRecord(context.conversation_state);
  const collected = asRecord(conversationState.collected);
  const rawHistory = Array.isArray(context.recent_history) ? context.recent_history : [];
  const sessionStartedAt = getSemanticSessionStartedAt(rawHistory);

  const qualificationFresh = isStoredSemanticItemInCurrentSession(
    collected.agent_qualification_updated_at,
    sessionStartedAt,
  );
  const staffRequestFresh = isStoredSemanticItemInCurrentSession(
    collected.agent_staff_request_updated_at,
    sessionStartedAt,
  );
  const bookingSubjectsFresh = isStoredSemanticItemInCurrentSession(
    collected.booking_subjects_updated_at,
    sessionStartedAt,
  );

  const qualificationState = qualificationFresh
    ? parseStoredAgentQualification(collected.agent_qualification)
    : null;
  const staffRequest = staffRequestFresh
    ? parseStaffRequest(asRecord(collected.agent_staff_request).request)
    : null;

  const firstName = asNullableString(knownContact.first_name);
  const lastName = asNullableString(knownContact.last_name);
  const displayName =
    asNullableString(knownContact.name)
    ?? (firstName && lastName ? `${firstName} ${lastName}` : null)
    ?? firstName
    ?? asNullableString(knownContact.username)
    ?? null;
  const patientReachableInCurrentChannel =
    asBoolean(collected.contact_channel_available)
    ?? asBoolean(conversationState.patient_reachable_in_current_channel)
    ?? false;

  return {
    _booking_subjects_fresh: bookingSubjectsFresh,
    patient_context: {
      display_name: displayName,
      preferred_language: asNullableString(knownContact.language_code),
      reachable_in_current_channel: patientReachableInCurrentChannel,
    },
    ...(qualificationState ? { qualification_state: qualificationState } : {}),
    ...(staffRequest ? {
      staff_request_context: {
        kind: staffRequest.kind,
        patient_target: staffRequest.patient_target,
        person_ref: staffRequest.person_ref,
        summary: staffRequest.summary,
        preferred_contact_window: staffRequest.preferred_contact_window,
        source: "patient_report",
      },
    } : {}),
    runtime_policy: {
      patient_reachable_in_current_channel: patientReachableInCurrentChannel,
    },
    recent_history: assembleRecentHistory(rawHistory),
  };
}

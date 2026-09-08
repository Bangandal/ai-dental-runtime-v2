import { parseStoredAgentQualification } from "./agentQualification.ts";
import { parseStaffRequest } from "./staffRequest.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";

const MAX_RECENT_HISTORY_MESSAGES = 8;
const MAX_RECENT_HISTORY_CHARS = 2000;
const DEFAULT_SEMANTIC_CONTEXT_TTL_HOURS = 24;

type UnknownRecord = Record<string, unknown>;
type NormalizedHistoryItem = { role: string; text: string; created_at: string | null };

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
    if (!item || typeof item !== "object") continue;
    const msg = item as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : null;
    const text =
      typeof msg.text === "string" && msg.text.trim()
        ? msg.text.trim()
        : typeof msg.content === "string" && msg.content.trim()
        ? msg.content.trim()
        : null;
    if (!role || !text) continue;
    normalized.push({
      role,
      text,
      created_at: asNullableString(msg.created_at),
    });
  }
  return normalized;
}

function capHistory(items: NormalizedHistoryItem[]): Array<{ role: string; text: string }> {
  const sliced = items.slice(-MAX_RECENT_HISTORY_MESSAGES);
  let totalChars = sliced.reduce((sum, m) => sum + m.text.length, 0);
  let start = 0;
  while (totalChars > MAX_RECENT_HISTORY_CHARS && start < sliced.length) {
    totalChars -= sliced[start].text.length;
    start++;
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
    const gap = currentMs - previousMs;
    if (gap > ttlMs) sessionStart = index;
  }
  return sessionStart;
}

export function getSemanticSessionStartedAt(
  raw: unknown[],
  ttlMs = resolveSemanticContextTtlMs(),
): string | null {
  const normalized = normalizeHistory(raw);
  if (normalized.length === 0) return null;
  const session = normalized.slice(findSessionStartIndex(normalized, ttlMs));
  return session[0]?.created_at ?? null;
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

// Legacy receives the historical capped recent history. Agent-first uses the same cap but
// first cuts everything before the most recent inactivity gap, creating a natural session.
export function assembleRecentHistory(raw: unknown[]): Array<{ role: string; text: string }> {
  return capHistory(normalizeHistory(raw));
}

export function assembleAgentFirstSessionHistory(
  raw: unknown[],
  ttlMs = resolveSemanticContextTtlMs(),
): Array<{ role: string; text: string }> {
  const normalized = normalizeHistory(raw);
  const session = normalized.slice(findSessionStartIndex(normalized, ttlMs));
  return capHistory(session);
}

export function buildModelVisibleRuntimeContext(runtimeContext: unknown): Record<string, unknown> {
  const context = asRecord(runtimeContext);
  const knownContact = asRecord(context.known_contact);
  const conversationState = asRecord(context.conversation_state);
  const persistedCollected = asRecord(conversationState.collected);
  const agentFirst = isAgentFirstRuntimeEnabled();
  const rawHistory = Array.isArray(context.recent_history) ? context.recent_history : [];
  const sessionStartedAt = agentFirst ? getSemanticSessionStartedAt(rawHistory) : null;

  // Agent-first no longer trusts unversioned legacy collected service/problem/time fields.
  // Durable semantic items are visible only when their own update timestamp belongs to the
  // current message session. Legacy keeps the historical collected-state behavior unchanged.
  const semanticCollected = agentFirst ? {} : persistedCollected;
  const qualificationFresh = !agentFirst || isStoredSemanticItemInCurrentSession(
    persistedCollected.agent_qualification_updated_at,
    sessionStartedAt,
  );
  const staffRequestFresh = !agentFirst || isStoredSemanticItemInCurrentSession(
    persistedCollected.agent_staff_request_updated_at,
    sessionStartedAt,
  );
  const bookingSubjectsFresh = !agentFirst || isStoredSemanticItemInCurrentSession(
    persistedCollected.booking_subjects_updated_at,
    sessionStartedAt,
  );
  const qualificationState = qualificationFresh
    ? parseStoredAgentQualification(persistedCollected.agent_qualification)
    : null;
  const staffRequest = staffRequestFresh
    ? parseStaffRequest(asRecord(persistedCollected.agent_staff_request).request)
    : null;

  const firstName = asNullableString(knownContact.first_name);
  const lastName = asNullableString(knownContact.last_name);
  const fullName = firstName && lastName ? `${firstName} ${lastName}` : null;
  const displayName =
    asNullableString(knownContact.name)
    ?? fullName
    ?? firstName
    ?? asNullableString(knownContact.username)
    ?? null;

  const contactChannelAvailable = asBoolean(persistedCollected.contact_channel_available);
  const patientReachableInCurrentChannel =
    contactChannelAvailable
    ?? asBoolean(conversationState.patient_reachable_in_current_channel)
    ?? false;

  const recentHistory = agentFirst
    ? assembleAgentFirstSessionHistory(rawHistory)
    : assembleRecentHistory(rawHistory);

  return {
    ...(agentFirst ? { _booking_subjects_fresh: bookingSubjectsFresh } : {}),
    patient_context: {
      display_name: displayName,
      preferred_language: asNullableString(knownContact.language_code),
      reachable_in_current_channel: patientReachableInCurrentChannel,
    },
    task_state: {
      collected: Object.fromEntries(
        [
          ["name", asNullableString(semanticCollected.name)],
          ["service_interest", asNullableString(semanticCollected.service_interest)],
          ["problem", asNullableString(semanticCollected.problem)],
          ["preferred_time", asNullableString(semanticCollected.preferred_time)],
          ["preferred_contact", asNullableString(semanticCollected.preferred_contact)],
          ...(contactChannelAvailable !== null ? [["contact_channel_available", contactChannelAvailable]] : []),
        ].filter(([, v]) => v !== null && v !== undefined),
      ),
      missing_fields: !agentFirst && Array.isArray(conversationState.missing_fields)
        ? conversationState.missing_fields.filter(
            (field): field is string =>
              typeof field === "string" &&
              !["phone", "first_name", "last_name", "name"].includes(field),
          )
        : [],
      last_known_intent: !agentFirst ? asNullableString(conversationState.intent) : null,
      intake_status: !agentFirst
        ? asNullableString(conversationState.qualification_stage) ?? asNullableString(conversationState.conversation_stage)
        : null,
    },
    ...(qualificationState ? { qualification_state: qualificationState } : {}),
    ...(staffRequest ? { staff_request_context: {
      kind: staffRequest.kind,
      patient_target: staffRequest.patient_target,
      person_ref: staffRequest.person_ref,
      summary: staffRequest.summary,
      preferred_contact_window: staffRequest.preferred_contact_window,
      source: "patient_report",
    } } : {}),
    runtime_policy: {
      phone_required: false,
      patient_reachable_in_current_channel: patientReachableInCurrentChannel,
    },
    recent_history: recentHistory,
  };
}

import { parseStoredAgentQualification } from "./agentQualification.ts";
import { parseStaffRequest } from "./staffRequest.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";

const MAX_RECENT_HISTORY_MESSAGES = 8;
const MAX_RECENT_HISTORY_CHARS = 2000;
const DEFAULT_SEMANTIC_CONTEXT_TTL_HOURS = 24;

type UnknownRecord = Record<string, unknown>;

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
  // Missing timestamps are treated as compatible/fresh so old fixtures and partially
  // migrated rows do not lose context unexpectedly. Production convo_state writes carry
  // updated_at, so normal patient sessions still get a real inactivity boundary.
  if (!updatedAt) return true;
  const parsed = new Date(updatedAt).getTime();
  if (!Number.isFinite(parsed)) return true;
  const age = now.getTime() - parsed;
  return age >= 0 && age <= ttlMs;
}

// Assembles recent_history from raw DB messages with message-count and char-budget caps.
// Returns dialogue evidence only — callers must not treat this as business proof.
export function assembleRecentHistory(raw: unknown[]): Array<{ role: string; text: string }> {
  const normalized: Array<{ role: string; text: string }> = [];
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
    normalized.push({ role, text });
  }

  const sliced = normalized.slice(-MAX_RECENT_HISTORY_MESSAGES);
  let totalChars = sliced.reduce((sum, m) => sum + m.text.length, 0);
  let start = 0;
  while (totalChars > MAX_RECENT_HISTORY_CHARS && start < sliced.length) {
    totalChars -= sliced[start].text.length;
    start++;
  }

  return sliced.slice(start);
}

export function buildModelVisibleRuntimeContext(runtimeContext: unknown): Record<string, unknown> {
  const context = asRecord(runtimeContext);
  const knownContact = asRecord(context.known_contact);
  const conversationState = asRecord(context.conversation_state);
  const persistedCollected = asRecord(conversationState.collected);
  const agentFirst = isAgentFirstRuntimeEnabled();
  const semanticMemoryFresh = !agentFirst || isSemanticContextFresh(
    asNullableString(conversationState.updated_at),
  );
  const collected = semanticMemoryFresh ? persistedCollected : {};
  const qualificationState = parseStoredAgentQualification(collected.agent_qualification);
  const staffRequest = parseStaffRequest(asRecord(collected.agent_staff_request).request);

  const firstName = asNullableString(knownContact.first_name);
  const lastName = asNullableString(knownContact.last_name);
  const fullName = firstName && lastName ? `${firstName} ${lastName}` : null;
  const displayName =
    asNullableString(knownContact.name)
    ?? fullName
    ?? firstName
    ?? asNullableString(knownContact.username)
    ?? null;

  // Channel reachability is transport state, not semantic memory, so it survives an
  // inactivity reset even when old service/problem/people context is hidden from the LLM.
  const contactChannelAvailable = asBoolean(persistedCollected.contact_channel_available);
  const patientReachableInCurrentChannel =
    contactChannelAvailable
    ?? asBoolean(conversationState.patient_reachable_in_current_channel)
    ?? false;

  const rawHistory = Array.isArray(context.recent_history) ? context.recent_history : [];
  const recentHistory = semanticMemoryFresh ? assembleRecentHistory(rawHistory) : [];

  return {
    ...(agentFirst ? { _semantic_memory_fresh: semanticMemoryFresh } : {}),
    patient_context: {
      display_name: displayName,
      preferred_language: asNullableString(knownContact.language_code),
      reachable_in_current_channel: patientReachableInCurrentChannel,
    },
    task_state: {
      collected: Object.fromEntries(
        [
          ["name", asNullableString(collected.name)],
          ["service_interest", asNullableString(collected.service_interest)],
          ["problem", asNullableString(collected.problem)],
          ["preferred_time", asNullableString(collected.preferred_time)],
          ["preferred_contact", asNullableString(collected.preferred_contact)],
          ...(contactChannelAvailable !== null ? [["contact_channel_available", contactChannelAvailable]] : []),
        ].filter(([, v]) => v !== null && v !== undefined),
      ),
      missing_fields: semanticMemoryFresh && Array.isArray(conversationState.missing_fields)
        ? conversationState.missing_fields.filter(
            (field): field is string =>
              typeof field === "string" &&
              !["phone", "first_name", "last_name", "name"].includes(field),
          )
        : [],
      last_known_intent: semanticMemoryFresh ? asNullableString(conversationState.intent) : null,
      intake_status: semanticMemoryFresh
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

const MAX_RECENT_HISTORY_MESSAGES = 8;
const MAX_RECENT_HISTORY_CHARS = 2000;

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

  // Cap by message count (most recent N)
  const sliced = normalized.slice(-MAX_RECENT_HISTORY_MESSAGES);

  // Cap by total char budget: drop oldest messages until within limit
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
  const collected = asRecord(conversationState.collected);

  const firstName = asNullableString(knownContact.first_name);
  const lastName = asNullableString(knownContact.last_name);
  const fullName = firstName && lastName ? `${firstName} ${lastName}` : null;
  const displayName =
    asNullableString(knownContact.name)
    ?? fullName
    ?? firstName
    ?? asNullableString(knownContact.username)
    ?? null;

  const contactChannelAvailable = asBoolean(collected.contact_channel_available);
  const patientReachableInCurrentChannel =
    contactChannelAvailable
    ?? asBoolean(conversationState.patient_reachable_in_current_channel)
    ?? false;

  const rawHistory = Array.isArray(context.recent_history) ? context.recent_history : [];
  const recentHistory = assembleRecentHistory(rawHistory);

  return {
    patient_context: {
      display_name: displayName,
      preferred_language: asNullableString(knownContact.language_code),
      reachable_in_current_channel: patientReachableInCurrentChannel,
    },
    task_state: {
      // Only include non-null collected fields. A null value means the field has not been
      // persisted to the booking system via booking.apply — it does NOT mean the patient
      // hasn't provided it. Omitting nulls prevents the model from treating absent persistence
      // as authoritative evidence that the field is unknown (it may be in conversation history).
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
      missing_fields: Array.isArray(conversationState.missing_fields)
        ? conversationState.missing_fields.filter(
            (field): field is string =>
              typeof field === "string" &&
              !["phone", "first_name", "last_name", "name"].includes(field),
          )
        : [],
      last_known_intent: asNullableString(conversationState.intent),
      intake_status: asNullableString(conversationState.qualification_stage) ?? asNullableString(conversationState.conversation_stage),
    },
    runtime_policy: {
      phone_required: false,
      patient_reachable_in_current_channel: patientReachableInCurrentChannel,
    },
    recent_history: recentHistory,
  };
}

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
    recent_history: [],
  };
}

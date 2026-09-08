import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isLegacySubjectId(value: unknown): value is string {
  return typeof value === "string" && /^subject_\d+$/.test(value);
}

function semanticContactOwner(
  owner: unknown,
  subjectsById: Map<string, Record<string, unknown>>,
): unknown {
  if (owner === "self" || owner == null) return owner;
  if (!isLegacySubjectId(owner)) return owner;
  if (owner === "subject_1") return "self";

  const subject = subjectsById.get(owner);
  if (!subject) return "other_person";
  return readString(subject.label) ?? readString(subject.patient_name) ?? "other_person";
}

function projectAgentFirstBaseContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const { locale, ...rest } = context;
  const languageHint = readString(locale);
  const channelContext = asObject(rest.channel_context);

  if (!languageHint) return rest;

  return {
    ...rest,
    channel_context: {
      ...(channelContext ?? {}),
      // Transport/profile locale is weak fallback metadata only. It must never be
      // interpreted as the language of the current conversation.
      language_hint: languageHint,
    },
  };
}

function projectAgentFirstRuntimeContext(
  runtimeContext: Record<string, unknown>,
): Record<string, unknown> {
  const projected = { ...runtimeContext };

  const patientContext = asObject(runtimeContext.patient_context);
  if (patientContext) {
    const { preferred_language, ...patientRest } = patientContext;
    const profileLanguageHint = readString(preferred_language);
    projected.patient_context = {
      ...patientRest,
      ...(profileLanguageHint ? { profile_language_hint: profileLanguageHint } : {}),
    };
  }

  const taskState = asObject(runtimeContext.task_state);
  if (taskState) {
    const {
      missing_fields: _missingFields,
      last_known_intent: _lastKnownIntent,
      intake_status: _intakeStatus,
      ...taskRest
    } = taskState;

    // These legacy process hints are useful to deterministic Runtime, but exposing
    // them to the agent-first model biases a fresh patient message toward stale
    // booking/intake work. Durable collected facts remain visible.
    projected.task_state = taskRest;
  }

  return projected;
}

/**
 * Final outbound projection before runtime context is serialized for the model.
 *
 * Internal subject_N identifiers remain available to deterministic runtime code through
 * the original caller context, but they are removed from the JSON payload sent to OpenAI.
 * The returned object is a detached projection and never mutates runtime state.
 *
 * Agent-first additionally removes provider/profile language claims and legacy intake
 * steering from the reasoning surface. Weak language metadata is explicitly named as a
 * hint, while the patient's messages remain authoritative for conversational language.
 */
export function projectModelFacingContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const agentFirst = isAgentFirstRuntimeEnabled();
  const baseContext = agentFirst
    ? projectAgentFirstBaseContext(context)
    : { ...context };

  const rawRuntimeContext = asObject(baseContext.runtime_context);
  if (!rawRuntimeContext) return baseContext;

  const runtimeContext = agentFirst
    ? projectAgentFirstRuntimeContext(rawRuntimeContext)
    : rawRuntimeContext;

  const bookingSubjects = asObject(runtimeContext.booking_subjects);
  if (!bookingSubjects) {
    return {
      ...baseContext,
      runtime_context: { ...runtimeContext },
    };
  }

  const rawSubjects = Array.isArray(bookingSubjects.subjects)
    ? bookingSubjects.subjects
    : [];
  const subjectsById = new Map<string, Record<string, unknown>>();

  for (const rawSubject of rawSubjects) {
    const subject = asObject(rawSubject);
    if (!subject) continue;
    if (isLegacySubjectId(subject.id)) subjectsById.set(subject.id, subject);
  }

  const projectedSubjects = rawSubjects.map((rawSubject) => {
    const subject = asObject(rawSubject);
    if (!subject) return rawSubject;

    const { id: _internalId, ...visibleSubject } = subject;
    return {
      ...visibleSubject,
      ...(Object.prototype.hasOwnProperty.call(visibleSubject, "contact_owner")
        ? { contact_owner: semanticContactOwner(visibleSubject.contact_owner, subjectsById) }
        : {}),
    };
  });

  const { active_subject_id: _internalActiveSubjectId, ...visibleBookingSubjects } = bookingSubjects;

  return {
    ...baseContext,
    runtime_context: {
      ...runtimeContext,
      booking_subjects: {
        ...visibleBookingSubjects,
        subjects: projectedSubjects,
      },
    },
  };
}

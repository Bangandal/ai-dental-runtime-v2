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
  profileLanguageHint: string | null,
): Record<string, unknown> {
  const {
    locale,
    truth_snapshot: truthSnapshot,
    recent_summary: recentSummary,
    ...rest
  } = context;
  const languageHint = readString(locale) ?? profileLanguageHint;
  const channelContext = asObject(rest.channel_context);
  const {
    patient_reachable_in_current_channel: _duplicateReachability,
    ...channelRest
  } = channelContext ?? {};

  return {
    ...rest,
    ...(truthSnapshot != null ? { truth_snapshot: truthSnapshot } : {}),
    ...(recentSummary != null ? { recent_summary: recentSummary } : {}),
    channel_context: {
      ...channelRest,
      ...(languageHint
        ? {
            // This is the only language metadata exposed in agent-first. It is a weak
            // fallback hint and must never override language established by dialogue.
            language_hint: languageHint,
          }
        : {}),
    },
  };
}

function projectAgentFirstRuntimeContext(
  runtimeContext: Record<string, unknown>,
): Record<string, unknown> {
  const projected = { ...runtimeContext };

  const patientContext = asObject(runtimeContext.patient_context);
  if (patientContext) {
    const {
      preferred_language: _preferredLanguage,
      profile_language_hint: _profileLanguageHint,
      reachable_in_current_channel: _duplicateReachability,
      ...patientRest
    } = patientContext;
    projected.patient_context = patientRest;
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
 * steering from the reasoning surface. Language/reachability metadata is exposed once,
 * under an explicitly weak/authoritative location, rather than repeated across the payload.
 */
export function projectModelFacingContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const agentFirst = isAgentFirstRuntimeEnabled();
  const rawRuntimeBeforeBase = asObject(context.runtime_context);
  const rawPatientBeforeBase = asObject(rawRuntimeBeforeBase?.patient_context);
  const profileLanguageHint = readString(rawPatientBeforeBase?.preferred_language)
    ?? readString(rawPatientBeforeBase?.profile_language_hint);

  const baseContext = agentFirst
    ? projectAgentFirstBaseContext(context, profileLanguageHint)
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

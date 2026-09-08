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

function projectVerifiedBookingSelection(raw: unknown): Record<string, unknown> | null {
  const state = asObject(raw);
  if (!state || state.slot_evidence_status !== "verified") return null;

  const slot = asObject(state.selected_slot);
  const startsAt = readString(slot?.starts_at);
  if (!slot || !startsAt) return null;

  const endsAt = readString(slot.ends_at);
  const slotId = readString(slot.slot_id);
  return {
    status: "verified",
    starts_at: startsAt,
    ...(endsAt ? { ends_at: endsAt } : {}),
    ...(slotId ? { slot_id: slotId } : {}),
  };
}

function projectAgentFirstBaseContext(
  context: Record<string, unknown>,
  profileLanguageHint: string | null,
): Record<string, unknown> {
  const {
    locale,
    truth_snapshot: truthSnapshot,
    recent_summary: recentSummary,
    booking_process_state: bookingProcessState,
    ...rest
  } = context;
  const languageHint = readString(locale) ?? profileLanguageHint;
  const channelContext = asObject(rest.channel_context);
  const {
    patient_reachable_in_current_channel: _duplicateReachability,
    ...channelRest
  } = channelContext ?? {};
  const bookingSelection = projectVerifiedBookingSelection(bookingProcessState);

  return {
    ...rest,
    ...(truthSnapshot != null ? { truth_snapshot: truthSnapshot } : {}),
    ...(recentSummary != null ? { recent_summary: recentSummary } : {}),
    ...(bookingSelection ? { booking_selection: bookingSelection } : {}),
    channel_context: {
      ...channelRest,
      ...(languageHint
        ? {
            language_hint: languageHint,
          }
        : {}),
    },
  };
}

function projectAgentFirstRuntimeContext(
  runtimeContext: Record<string, unknown>,
): Record<string, unknown> {
  const semanticMemoryFresh = runtimeContext._semantic_memory_fresh !== false;
  const {
    case_context: _caseContext,
    booking_context: _bookingContext,
    _semantic_memory_fresh: _semanticMemoryFresh,
    ...runtimeRest
  } = runtimeContext;
  const projected: Record<string, unknown> = { ...runtimeRest };

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
      phone_received: _phoneReceived,
      phone_captured: _phoneCaptured,
      phone_source: _phoneSource,
      phone_trust: _phoneTrust,
      ...taskRest
    } = taskState;
    const collected = asObject(taskRest.collected);
    if (collected) {
      const {
        contact_channel_available: _duplicateReachability,
        ...collectedFacts
      } = collected;
      const compactTask = { ...taskRest, collected: collectedFacts };
      if (Object.keys(collectedFacts).length === 0 && Object.keys(taskRest).every((key) => key === "collected")) {
        delete projected.task_state;
      } else {
        projected.task_state = compactTask;
      }
    } else if (Object.keys(taskRest).length > 0) {
      projected.task_state = taskRest;
    } else {
      delete projected.task_state;
    }
  }

  const runtimePolicy = asObject(runtimeContext.runtime_policy);
  if (runtimePolicy) {
    const {
      phone_required: _constantPhoneRequired,
      ...policyRest
    } = runtimePolicy;
    if (Object.keys(policyRest).length > 0) projected.runtime_policy = policyRest;
    else delete projected.runtime_policy;
  }

  const qualificationState = asObject(runtimeContext.qualification_state);
  if (qualificationState && semanticMemoryFresh) {
    const {
      route: _route,
      urgency: _urgency,
      red_flags: _redFlags,
      policy_applied: _policyApplied,
      summary: _modelSummary,
      ...patientReportedQualification
    } = qualificationState;
    if (Object.keys(patientReportedQualification).length > 0) {
      projected.qualification_state = patientReportedQualification;
    } else {
      delete projected.qualification_state;
    }
  } else {
    delete projected.qualification_state;
  }

  if (!semanticMemoryFresh) {
    // A new session must not inherit an old task/person/callback narrative. Runtime keeps
    // durable operational state privately, while the model starts from the new patient turn.
    delete projected.task_state;
    delete projected.staff_request_context;
    delete projected.booking_subjects;
    projected.recent_history = [];
  }

  delete projected.case_context;
  delete projected.booking_context;

  return projected;
}

/**
 * Final outbound projection before runtime context is serialized for the model.
 *
 * Internal subject_N identifiers remain available to deterministic runtime code through
 * the original caller context, but they are removed from the JSON payload sent to OpenAI.
 * The returned object is a detached projection and never mutates runtime state.
 *
 * Agent-first exposes conversational evidence and known facts, not Runtime's hidden state
 * machines. Full booking_process_state, historical case summaries, missing-field lists,
 * readiness statuses, transport phone metadata and old clinical-routing decisions stay
 * Runtime-private. A verified selected slot is projected separately as booking_selection
 * because it is a concrete continuity fact rather than a next-step order.
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

  const semanticMemoryFresh = rawRuntimeContext._semantic_memory_fresh !== false;
  const runtimeContext = agentFirst
    ? projectAgentFirstRuntimeContext(rawRuntimeContext)
    : rawRuntimeContext;

  const bookingSubjects = semanticMemoryFresh || !agentFirst
    ? asObject(runtimeContext.booking_subjects)
    : null;
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

    if (agentFirst) {
      const {
        id: _internalId,
        missing: _missing,
        status: _status,
        booking_contact: _bookingContact,
        role: _role,
        slot: _slot,
        phone_status: _phoneStatus,
        contact_owner: _contactOwner,
        ...semanticPersonFacts
      } = subject;
      return semanticPersonFacts;
    }

    const {
      id: _internalId,
      missing: _missing,
      status,
      booking_contact: _bookingContact,
      role: _role,
      slot,
      ...visibleSubject
    } = subject;
    return {
      ...visibleSubject,
      ...(status === "booked" ? { is_booked: true } : {}),
      ...(status === "booked" && typeof slot === "string" && slot.trim().length > 0
        ? { slot }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(visibleSubject, "contact_owner")
        ? { contact_owner: semanticContactOwner(visibleSubject.contact_owner, subjectsById) }
        : {}),
    };
  });

  const {
    version: _version,
    status: _registryStatus,
    active_subject_id: _internalActiveSubjectId,
    pending_typed_phone: pendingTypedPhone,
    max_subjects: _maxSubjects,
    ...visibleBookingSubjects
  } = bookingSubjects;

  return {
    ...baseContext,
    runtime_context: {
      ...runtimeContext,
      booking_subjects: {
        ...visibleBookingSubjects,
        ...(!agentFirst && typeof pendingTypedPhone === "string" && pendingTypedPhone.trim().length > 0
          ? { has_pending_typed_phone: true }
          : {}),
        subjects: projectedSubjects,
      },
    },
  };
}

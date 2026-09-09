import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hasSubstantivePatientLanguageSignal(text: string): boolean {
  const words = text.match(/\p{L}+/gu) ?? [];
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length >= 6 || (words.length >= 2 && letters.length >= 4);
}

function hasEstablishedPatientLanguage(runtimeContext: Record<string, unknown> | null): boolean {
  const history = Array.isArray(runtimeContext?.recent_history)
    ? runtimeContext.recent_history
    : [];
  const userTexts = history.flatMap((raw) => {
    const item = asObject(raw);
    if (readString(item?.role) !== "user") return [];
    const text = readString(item?.text)?.trim();
    return text ? [text] : [];
  });

  // The orchestrator persists the current inbound before building model context, so the
  // last user item is normally the current turn. A prior substantive patient message already
  // establishes dialogue language. A substantive current message can also establish language
  // on the first turn and must not compete with channel/profile metadata. Low-signal turns such
  // as "17:00", "?", "Так" or "да" keep the fallback hint when no prior dialogue exists.
  const priorEstablished = userTexts.slice(0, -1).some(hasSubstantivePatientLanguageSignal);
  const currentText = userTexts.at(-1);
  return priorEstablished || (currentText != null && hasSubstantivePatientLanguageSignal(currentText));
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
  patientLanguageEstablished: boolean,
): Record<string, unknown> {
  const {
    locale,
    truth_snapshot: truthSnapshot,
    recent_summary: recentSummary,
    booking_process_state: bookingProcessState,
    ...rest
  } = context;
  const languageHint = patientLanguageEstablished
    ? null
    : readString(locale) ?? profileLanguageHint;
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
  const {
    case_context: _caseContext,
    booking_context: _bookingContext,
    _booking_subjects_fresh: _bookingSubjectsFresh,
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
      const remainingTaskKeys = Object.keys(taskRest).filter((key) => key !== "collected");
      if (Object.keys(collectedFacts).length === 0 && remainingTaskKeys.length === 0) {
        delete projected.task_state;
      } else {
        projected.task_state = { ...taskRest, collected: collectedFacts };
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
  if (qualificationState) {
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
 * Agent-first exposes conversational evidence and session-scoped known facts, not Runtime's
 * hidden state machines. Full booking_process_state, historical case summaries, missing-field
 * lists, readiness statuses, transport phone metadata and old clinical-routing decisions stay
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
  const patientLanguageEstablished = hasEstablishedPatientLanguage(rawRuntimeBeforeBase);

  const baseContext = agentFirst
    ? projectAgentFirstBaseContext(context, profileLanguageHint, patientLanguageEstablished)
    : { ...context };

  const rawRuntimeContext = asObject(baseContext.runtime_context);
  if (!rawRuntimeContext) return baseContext;

  const bookingSubjectsFresh = rawRuntimeContext._booking_subjects_fresh !== false;
  const runtimeContext = agentFirst
    ? projectAgentFirstRuntimeContext(rawRuntimeContext)
    : rawRuntimeContext;

  const bookingSubjects = !agentFirst || bookingSubjectsFresh
    ? asObject(runtimeContext.booking_subjects)
    : null;
  if (!bookingSubjects) {
    if (agentFirst) delete runtimeContext.booking_subjects;
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

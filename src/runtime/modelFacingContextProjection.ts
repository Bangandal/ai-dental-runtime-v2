function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasSubstantivePatientLanguageSignal(text: string): boolean {
  const words = text.match(/\p{L}+/gu) ?? [];
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length >= 6 || (words.length >= 2 && letters.length >= 4);
}

function hasEstablishedPatientLanguage(runtimeContext: Record<string, unknown> | null): boolean {
  const history = Array.isArray(runtimeContext?.recent_history) ? runtimeContext.recent_history : [];
  const userTexts = history.flatMap((raw) => {
    const item = asObject(raw);
    if (readString(item?.role) !== "user") return [];
    const text = readString(item?.text);
    return text ? [text] : [];
  });
  const priorEstablished = userTexts.slice(0, -1).some(hasSubstantivePatientLanguageSignal);
  const currentText = userTexts.at(-1);
  return priorEstablished || (currentText != null && hasSubstantivePatientLanguageSignal(currentText));
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

function projectBaseContext(
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
  const languageHint = patientLanguageEstablished ? null : readString(locale) ?? profileLanguageHint;
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
      ...(languageHint ? { language_hint: languageHint } : {}),
    },
  };
}

function projectRuntimeContext(runtimeContext: Record<string, unknown>): Record<string, unknown> {
  const {
    _booking_subjects_fresh: _bookingSubjectsFresh,
    case_context: _caseContext,
    booking_context: _bookingContext,
    task_state: _taskState,
    ...runtimeRest
  } = runtimeContext;
  const projected: Record<string, unknown> = { ...runtimeRest };

  const patientContext = asObject(runtimeContext.patient_context);
  if (patientContext) {
    const {
      preferred_language: _preferredLanguage,
      profile_language_hint: _profileLanguageHint,
      reachable_in_current_channel: _duplicateReachability,
      ...patientFacts
    } = patientContext;
    if (Object.keys(patientFacts).length > 0) projected.patient_context = patientFacts;
    else delete projected.patient_context;
  }

  const runtimePolicy = asObject(runtimeContext.runtime_policy);
  if (runtimePolicy) {
    const {
      phone_required: _phoneRequired,
      ...policyFacts
    } = runtimePolicy;
    if (Object.keys(policyFacts).length > 0) projected.runtime_policy = policyFacts;
    else delete projected.runtime_policy;
  }

  const qualificationState = asObject(runtimeContext.qualification_state);
  if (qualificationState) {
    const {
      route: _route,
      urgency: _urgency,
      red_flags: _redFlags,
      policy_applied: _policyApplied,
      summary: _summary,
      ...patientReportedFacts
    } = qualificationState;
    if (Object.keys(patientReportedFacts).length > 0) projected.qualification_state = patientReportedFacts;
    else delete projected.qualification_state;
  }

  delete projected.case_context;
  delete projected.booking_context;
  delete projected.task_state;
  return projected;
}

/**
 * The only outbound model projection. Deterministic state machines, technical subject ids,
 * booking contacts and transport metadata remain Runtime-private.
 */
export function projectModelFacingContext(context: Record<string, unknown>): Record<string, unknown> {
  const rawRuntimeBeforeBase = asObject(context.runtime_context);
  const rawPatientBeforeBase = asObject(rawRuntimeBeforeBase?.patient_context);
  const profileLanguageHint = readString(rawPatientBeforeBase?.preferred_language)
    ?? readString(rawPatientBeforeBase?.profile_language_hint);
  const patientLanguageEstablished = hasEstablishedPatientLanguage(rawRuntimeBeforeBase);
  const baseContext = projectBaseContext(context, profileLanguageHint, patientLanguageEstablished);

  const rawRuntimeContext = asObject(baseContext.runtime_context);
  if (!rawRuntimeContext) return baseContext;
  const bookingSubjectsFresh = rawRuntimeContext._booking_subjects_fresh !== false;
  const runtimeContext = projectRuntimeContext(rawRuntimeContext);
  const bookingSubjects = bookingSubjectsFresh ? asObject(runtimeContext.booking_subjects) : null;

  if (!bookingSubjects) {
    delete runtimeContext.booking_subjects;
    return { ...baseContext, runtime_context: runtimeContext };
  }

  const rawSubjects = Array.isArray(bookingSubjects.subjects) ? bookingSubjects.subjects : [];
  const projectedSubjects = rawSubjects.flatMap((rawSubject) => {
    const subject = asObject(rawSubject);
    if (!subject) return [];
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
    return [semanticPersonFacts];
  });

  const {
    version: _version,
    status: _registryStatus,
    active_subject_id: _internalActiveSubjectId,
    pending_typed_phone: _pendingTypedPhone,
    max_subjects: _maxSubjects,
    ...semanticRegistry
  } = bookingSubjects;

  return {
    ...baseContext,
    runtime_context: {
      ...runtimeContext,
      booking_subjects: {
        ...semanticRegistry,
        subjects: projectedSubjects,
      },
    },
  };
}

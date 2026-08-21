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

/**
 * Final outbound projection before runtime context is serialized for the model.
 *
 * Internal subject_N identifiers remain available to deterministic runtime code through
 * the original caller context, but they are removed from the JSON payload sent to OpenAI.
 * The returned object is a detached projection and never mutates runtime state.
 */
export function projectModelFacingContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const runtimeContext = asObject(context.runtime_context);
  if (!runtimeContext) return { ...context };

  const bookingSubjects = asObject(runtimeContext.booking_subjects);
  if (!bookingSubjects) {
    return {
      ...context,
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
    ...context,
    runtime_context: {
      ...runtimeContext,
      booking_subjects: {
        ...visibleBookingSubjects,
        subjects: projectedSubjects,
      },
    },
  };
}

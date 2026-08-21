import {
  parsePhoneOwnershipIntent,
  parseStrictSubjectId,
  parseSubjectIntent,
  type PhoneOwnershipIntent,
  type SubjectId,
  type SubjectIntent,
} from "./bookingSubjectsState.ts";

export interface ParsedModelPersonIntents {
  subject_intent?: SubjectIntent;
  phone_ownership_intent?: PhoneOwnershipIntent;
}

interface ModelPersonCandidate {
  id: SubjectId;
  label: string | null;
  patient_name: string | null;
}

interface ModelPersonResolutionContext {
  active_subject_id: SubjectId | null;
  subjects: ModelPersonCandidate[];
}

type SemanticPersonTarget = "self" | "active" | "other_person";

const KNOWN_SUBJECT_ACTIONS = new Set([
  "none",
  "switch_subject",
  "create_subjects",
  "create_or_switch_subject",
  "start_new_episode",
]);
const KNOWN_PHONE_ACTIONS = new Set([
  "none",
  "assign_pending_phone",
  "share_sender_contact",
]);
const LEGACY_TARGETS = new Set(["self", "mentioned_person", "active"]);
const SEMANTIC_TARGETS = new Set<SemanticPersonTarget>(["self", "active", "other_person"]);

const SEMANTIC_PERSON_PROTOCOL = [
  "## BOOKING PEOPLE",
  "Treat people by business meaning. Never use or emit internal subject identifiers.",
  "runtime_context.booking_subjects.subjects exposes human label/name plus person_kind and is_active. Use those fields to identify the intended person.",
  "Include subject_intent in final_response only when switching person or creating another person.",
  'subject_intent: {action:"none"|"switch_subject"|"create_subjects", target:"self"|"active"|"other_person", person_ref:null|string, display_name:null|string, count:null|1..4, labels:[], confidence:"low"|"medium"|"high"}',
  "For other_person, set person_ref to the exact visible label or patient_name when more than one other person exists. If the person is ambiguous, ask which person and do not guess.",
  "When pending_typed_phone is set, ask whose phone it is and include phone_ownership_intent in final_response.",
  'phone_ownership_intent: {action:"assign_pending_phone"|"share_sender_contact"|"none", target:"self"|"active"|"other_person", person_ref:null|string, confidence:"low"|"medium"|"high"}',
  "Never emit subject_id, target_subject_id, subject_1, subject_2, subject_3, or subject_4.",
].join("\n");

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeRef(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function readResolutionContext(modelContext: Record<string, unknown> | null | undefined): ModelPersonResolutionContext {
  const runtimeContext = asObject(modelContext?.runtime_context);
  const bookingSubjects = asObject(runtimeContext?.booking_subjects);
  const activeSubjectId = parseStrictSubjectId(bookingSubjects?.active_subject_id);
  const rawSubjects = Array.isArray(bookingSubjects?.subjects) ? bookingSubjects.subjects : [];
  const subjects: ModelPersonCandidate[] = [];

  for (const rawSubject of rawSubjects) {
    const subject = asObject(rawSubject);
    if (!subject) continue;
    const id = parseStrictSubjectId(subject.id);
    if (!id) continue;
    subjects.push({
      id,
      label: readString(subject.label),
      patient_name: readString(subject.patient_name),
    });
  }

  return { active_subject_id: activeSubjectId, subjects };
}

function resolveOtherPerson(
  context: ModelPersonResolutionContext,
  personRef: string | null,
): SubjectId | null {
  const candidates = context.subjects.filter((subject) => subject.id !== "subject_1");
  const normalizedRef = normalizeRef(personRef);

  if (normalizedRef) {
    const matches = candidates.filter((subject) => {
      const label = normalizeRef(subject.label);
      const patientName = normalizeRef(subject.patient_name);
      return label === normalizedRef || patientName === normalizedRef;
    });
    return matches.length === 1 ? matches[0]!.id : null;
  }

  return candidates.length === 1 ? candidates[0]!.id : null;
}

function resolveSemanticTarget(
  target: SemanticPersonTarget,
  personRef: string | null,
  context: ModelPersonResolutionContext,
): SubjectId | null {
  if (target === "self") return "subject_1";
  if (target === "active") return context.active_subject_id;
  return resolveOtherPerson(context, personRef);
}

function readSemanticTarget(value: unknown): SemanticPersonTarget | null {
  return typeof value === "string" && SEMANTIC_TARGETS.has(value as SemanticPersonTarget)
    ? value as SemanticPersonTarget
    : null;
}

function failClosedSubjectIntent(
  action: "switch_subject" | "create_or_switch_subject",
  obj: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...obj,
    action,
    target: "mentioned_person",
    subject_id: null,
    confidence: "low",
  };
}

/**
 * Project the historical runtime instruction to the semantic model-facing people protocol.
 * The internal runtime may keep legacy subject_N terminology while the model never sees it.
 */
export function projectModelPersonInstruction(systemInstruction: string): string {
  const startMarker = "## BOOKING SUBJECTS";
  const endMarker = "## BOOKING FLOW";
  const start = systemInstruction.indexOf(startMarker);
  const end = systemInstruction.indexOf(endMarker, start >= 0 ? start : 0);
  if (start < 0 || end < 0 || end <= start) {
    return systemInstruction;
  }
  return `${systemInstruction.slice(0, start)}${SEMANTIC_PERSON_PROTOCOL}\n\n${systemInstruction.slice(end)}`;
}

/**
 * Normalize both new semantic person intents and historical subject-id intents into the
 * strict internal SubjectIntent contract. Semantic references are resolved deterministically
 * from the model-visible registry. Ambiguity is fail-closed via low confidence.
 */
export function normalizeSubjectIntentEnvelope(
  obj: Record<string, unknown>,
  modelContext?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const action = readString(obj.action);
  if (!action || !KNOWN_SUBJECT_ACTIONS.has(action)) return null;

  if (action === "start_new_episode") return obj;

  if (action === "create_subjects") {
    const rawLabels = Array.isArray(obj.labels)
      ? (obj.labels as unknown[]).filter((label): label is string => typeof label === "string")
      : [];
    const rawCount = typeof obj.count === "number" ? obj.count : rawLabels.length || 1;
    const count = Math.max(1, Math.min(4, rawCount));
    return {
      ...obj,
      target: "mentioned_person",
      subject_id: null,
      confidence: readString(obj.confidence) ?? "medium",
      count,
      labels: rawLabels.length > 0 ? rawLabels : null,
    };
  }

  if (action === "none") {
    return {
      ...obj,
      target: LEGACY_TARGETS.has(readString(obj.target) ?? "") ? obj.target : "active",
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  if (action !== "switch_subject" && action !== "create_or_switch_subject") return null;

  const context = readResolutionContext(modelContext);
  const rawTarget = readString(obj.target);
  const semanticTarget = readSemanticTarget(rawTarget);
  const hasPersonRef = Object.prototype.hasOwnProperty.call(obj, "person_ref");
  const personRef = readString(obj.person_ref) ?? readString(obj.display_name);
  const legacySubjectId = parseStrictSubjectId(obj.subject_id);

  // Hidden historical callers may still identify a switch by canonical subject_id alone,
  // or by mentioned_person + subject_id. Once semantic fields are present, they win and
  // any model-hallucinated technical ID is ignored.
  const isLegacyCanonicalSwitch = action === "switch_subject"
    && legacySubjectId !== null
    && semanticTarget === null
    && !hasPersonRef
    && (rawTarget === null || rawTarget === "mentioned_person");
  if (isLegacyCanonicalSwitch) {
    return {
      ...obj,
      target: "mentioned_person",
      subject_id: legacySubjectId,
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  // Preserve the historical internal create-or-switch bootstrap shape. This action is not
  // part of the model-facing semantic protocol, so it remains a compatibility-only path.
  if (action === "create_or_switch_subject" && rawTarget === null && !hasPersonRef) {
    return {
      ...obj,
      target: "mentioned_person",
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  // Historical mentioned_person without an ID is treated like semantic other_person,
  // but is no longer allowed to silently select the first of multiple people.
  const effectiveTarget: SemanticPersonTarget | null = semanticTarget
    ?? (rawTarget === "mentioned_person" ? "other_person" : null);
  if (!effectiveTarget) return null;

  const resolvedSubjectId = resolveSemanticTarget(effectiveTarget, personRef, context);
  if (resolvedSubjectId) {
    return {
      ...obj,
      target: resolvedSubjectId === "subject_1" ? "self" : "mentioned_person",
      subject_id: resolvedSubjectId === "subject_1" ? null : resolvedSubjectId,
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  // create_or_switch_subject may bootstrap the very first other person when no registry
  // candidate exists. Once any other person exists, an unresolved reference must not fall
  // back to the first mentioned person.
  const otherCandidates = context.subjects.filter((subject) => subject.id !== "subject_1");
  if (action === "create_or_switch_subject" && effectiveTarget === "other_person" && otherCandidates.length === 0) {
    return {
      ...obj,
      target: "mentioned_person",
      subject_id: null,
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  return failClosedSubjectIntent(action, obj);
}

function normalizePhoneOwnershipIntent(
  obj: Record<string, unknown>,
  modelContext?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const action = readString(obj.action);
  if (!action || !KNOWN_PHONE_ACTIONS.has(action)) return null;

  const confidence = readString(obj.confidence) ?? "medium";
  if (action === "none") {
    return { ...obj, target_subject_id: null, confidence };
  }

  const hasSemanticFields = Object.prototype.hasOwnProperty.call(obj, "target")
    || Object.prototype.hasOwnProperty.call(obj, "person_ref");
  if (!hasSemanticFields) {
    return { ...obj, confidence };
  }

  const context = readResolutionContext(modelContext);
  const rawTarget = readString(obj.target);
  const semanticTarget = readSemanticTarget(rawTarget)
    ?? (rawTarget === "mentioned_person" ? "other_person" : null);
  const personRef = readString(obj.person_ref);
  if (!semanticTarget) {
    return { ...obj, target_subject_id: null, confidence: "low" };
  }

  const resolvedSubjectId = resolveSemanticTarget(semanticTarget, personRef, context);
  return {
    ...obj,
    target_subject_id: resolvedSubjectId,
    confidence: resolvedSubjectId ? confidence : "low",
  };
}

/**
 * Parse all model-produced person-management signals in one place.
 * Semantic model output is translated into the legacy deterministic state-machine contract;
 * hidden legacy output remains accepted for compatibility.
 */
export function parseModelPersonIntents(
  structuredFinal: Record<string, unknown> | null,
  envelope: Record<string, unknown> | null,
  modelContext?: Record<string, unknown> | null,
): ParsedModelPersonIntents {
  const structuredSubject = asObject(structuredFinal?.subject_intent);
  const envelopeSubject = asObject(envelope?.subject_intent)
    ?? (envelope && readString(envelope.action) ? envelope : null);
  const normalizedStructuredSubject = structuredSubject
    ? normalizeSubjectIntentEnvelope(structuredSubject, modelContext)
    : null;
  const normalizedEnvelopeSubject = envelopeSubject
    ? normalizeSubjectIntentEnvelope(envelopeSubject, modelContext)
    : null;
  const subjectIntent =
    (normalizedStructuredSubject ? parseSubjectIntent(normalizedStructuredSubject) : null) ??
    (normalizedEnvelopeSubject ? parseSubjectIntent(normalizedEnvelopeSubject) : null) ??
    undefined;

  const structuredPhone = asObject(structuredFinal?.phone_ownership_intent);
  const envelopePhone = asObject(envelope?.phone_ownership_intent);
  const normalizedStructuredPhone = structuredPhone
    ? normalizePhoneOwnershipIntent(structuredPhone, modelContext)
    : null;
  const normalizedEnvelopePhone = envelopePhone
    ? normalizePhoneOwnershipIntent(envelopePhone, modelContext)
    : null;
  const phoneOwnershipIntent =
    (normalizedStructuredPhone ? parsePhoneOwnershipIntent(normalizedStructuredPhone) : null) ??
    (normalizedEnvelopePhone ? parsePhoneOwnershipIntent(normalizedEnvelopePhone) : null) ??
    undefined;

  return {
    ...(subjectIntent !== undefined ? { subject_intent: subjectIntent } : {}),
    ...(phoneOwnershipIntent !== undefined ? { phone_ownership_intent: phoneOwnershipIntent } : {}),
  };
}

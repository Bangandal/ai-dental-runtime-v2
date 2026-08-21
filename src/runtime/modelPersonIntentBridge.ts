import {
  parsePhoneOwnershipIntent,
  parseSubjectIntent,
  type PhoneOwnershipIntent,
  type SubjectIntent,
} from "./bookingSubjectsState.ts";

export interface ParsedModelPersonIntents {
  subject_intent?: SubjectIntent;
  phone_ownership_intent?: PhoneOwnershipIntent;
}

const KNOWN_SUBJECT_ACTIONS = new Set([
  "none",
  "switch_subject",
  "create_subjects",
  "create_or_switch_subject",
  "start_new_episode",
]);
const VALID_TARGETS = new Set(["self", "mentioned_person", "active"]);
const SUBJECT_ID_RE = /^subject_\d+$/;

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Normalize the historical free-form subject-intent envelope before handing it to
 * the deterministic parser. This keeps legacy person-selection protocol out of the
 * OpenAI transport adapter while preserving exact behavior.
 */
export function normalizeSubjectIntentEnvelope(
  obj: Record<string, unknown>,
): Record<string, unknown> | null {
  const action = readString(obj.action);
  if (!action || !KNOWN_SUBJECT_ACTIONS.has(action)) return null;

  if (action === "switch_subject") {
    const target = readString(obj.target);
    const subjectId = readString(obj.subject_id);
    const hasValidTarget = VALID_TARGETS.has(target ?? "");
    const hasValidSubjectId = subjectId !== null && SUBJECT_ID_RE.test(subjectId);

    // An explicit canonical subject_id is sufficient to identify the person in the
    // legacy protocol. The state machine remains the authority for whether it exists.
    if (!hasValidTarget && !hasValidSubjectId) return null;
    return {
      ...obj,
      target: hasValidTarget ? target : "mentioned_person",
      ...(hasValidSubjectId ? { subject_id: subjectId } : {}),
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  if (action === "create_subjects") {
    const rawLabels = Array.isArray(obj.labels)
      ? (obj.labels as unknown[]).filter((label): label is string => typeof label === "string")
      : [];
    const rawCount = typeof obj.count === "number" ? obj.count : rawLabels.length || 1;
    const count = Math.max(1, Math.min(4, rawCount));
    return {
      ...obj,
      target: readString(obj.target) ?? "mentioned_person",
      confidence: readString(obj.confidence) ?? "medium",
      count,
      labels: rawLabels.length > 0 ? rawLabels : null,
    };
  }

  if (action === "create_or_switch_subject") {
    const target = readString(obj.target);
    return {
      ...obj,
      target: VALID_TARGETS.has(target ?? "") ? target : "mentioned_person",
      confidence: readString(obj.confidence) ?? "medium",
    };
  }

  // action === "none" or historical start_new_episode. The deterministic parser
  // intentionally rejects removed actions such as start_new_episode.
  return obj;
}

/**
 * Parse all model-produced person-management signals in one place.
 * `structuredFinal` is response.final_response, `envelope` is parsed output JSON.
 */
export function parseModelPersonIntents(
  structuredFinal: Record<string, unknown> | null,
  envelope: Record<string, unknown> | null,
): ParsedModelPersonIntents {
  const normalizedEnvelope = envelope ? normalizeSubjectIntentEnvelope(envelope) : null;
  const subjectIntent =
    parseSubjectIntent(structuredFinal?.subject_intent) ??
    (normalizedEnvelope ? parseSubjectIntent(normalizedEnvelope) : null) ??
    undefined;
  const phoneOwnershipIntent =
    parsePhoneOwnershipIntent(structuredFinal?.phone_ownership_intent) ??
    parsePhoneOwnershipIntent(envelope?.phone_ownership_intent) ??
    undefined;

  return {
    ...(subjectIntent !== undefined ? { subject_intent: subjectIntent } : {}),
    ...(phoneOwnershipIntent !== undefined ? { phone_ownership_intent: phoneOwnershipIntent } : {}),
  };
}

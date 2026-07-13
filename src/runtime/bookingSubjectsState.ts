import type { ChannelContact, ProvidedPhone } from "./openaiRuntimeAgent.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import { TRUSTED_PHONE_SOURCES } from "../integrations/cliniccard/bookingApplyExecutor.ts";

// ── v3 types ──────────────────────────────────────────────────────────────────

export type SubjectId = `subject_${number}`;

export type BookingContactSource =
  | "telegram_contact_button"
  | "whatsapp_sender"
  | "existing_cliniccard_patient"
  | "typed"
  | "shared_from_subject";

export type BookingContactTrust = "trusted" | "unverified" | "trusted_contact_owner";

export interface BookingContact {
  phone_number: string;
  source: BookingContactSource;
  trust: BookingContactTrust;
  /** Which subject owns this contact. null = self-owned. */
  owner_subject_id: SubjectId | null;
  collected_at: string | null;
}

export interface BookingSubject {
  id: SubjectId;
  role: "sender" | "mentioned_person";
  label: string | null;        // "я", "мама", "дочь 1", "дочь 2"
  patient_name: string | null;
  service: string | null;
  slot: string | null;
  booking_contact: BookingContact | null;
  status: "collecting" | "ready_for_booking" | "booked";
  missing: string[];           // computed, refreshed on every update
}

export interface BookingSubjectsState {
  version: 3;
  status: "active" | "completed";
  active_subject_id: SubjectId;
  subjects: BookingSubject[];
  pending_typed_phone: string | null;
  max_subjects: 4;
}

export interface S1Seed {
  name: string | null;
  service: string | null;
  slot: string | null;
}

// ── subject_intent v3 ─────────────────────────────────────────────────────────

export interface SubjectIntent {
  action: "none" | "switch_subject" | "create_subjects" | "create_or_switch_subject" | "start_new_episode";
  target: "self" | "mentioned_person" | "active";
  subject_id?: SubjectId | null;
  display_name?: string | null;
  count?: number | null;           // for create_subjects
  labels?: string[] | null;        // for create_subjects
  confidence: "low" | "medium" | "high";
}

const SUBJECT_ID_RE = /^subject_\d+$/;

export function parseSubjectIntent(raw: unknown): SubjectIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  let action = r.action as string;
  const target = r.target;
  const confidence = r.confidence;

  // Backward compat: old create_subject (singular) → create_subjects
  if (action === "create_subject") action = "create_subjects";

  if (!["none", "switch_subject", "create_subjects", "create_or_switch_subject", "start_new_episode"].includes(action)) return null;
  if (!["self", "mentioned_person", "active"].includes(target as string)) return null;
  if (!["low", "medium", "high"].includes(confidence as string)) return null;

  const subjectId = typeof r.subject_id === "string" && SUBJECT_ID_RE.test(r.subject_id)
    ? (r.subject_id as SubjectId)
    : null;

  const rawCount = r.count;
  const count = typeof rawCount === "number" && rawCount >= 1 && rawCount <= 4
    ? Math.floor(rawCount)
    : null;

  const rawLabels = r.labels;
  const labels = Array.isArray(rawLabels)
    ? rawLabels.filter((l): l is string => typeof l === "string")
    : null;

  return {
    action: action as SubjectIntent["action"],
    target: target as SubjectIntent["target"],
    subject_id: subjectId,
    display_name: typeof r.display_name === "string" ? r.display_name : null,
    count,
    labels: labels && labels.length > 0 ? labels : null,
    confidence: confidence as SubjectIntent["confidence"],
  };
}

// ── phone_ownership_intent ────────────────────────────────────────────────────

export interface PhoneOwnershipIntent {
  action: "none" | "assign_pending_phone" | "share_sender_contact";
  target_subject_id: SubjectId | null;
  confidence: "low" | "medium" | "high";
}

export function parsePhoneOwnershipIntent(raw: unknown): PhoneOwnershipIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const action = r.action;
  const confidence = r.confidence;

  if (!["none", "assign_pending_phone", "share_sender_contact"].includes(action as string)) return null;
  if (!["low", "medium", "high"].includes(confidence as string)) return null;

  const target = typeof r.target_subject_id === "string" && SUBJECT_ID_RE.test(r.target_subject_id)
    ? (r.target_subject_id as SubjectId)
    : null;

  return {
    action: action as PhoneOwnershipIntent["action"],
    target_subject_id: target,
    confidence: confidence as PhoneOwnershipIntent["confidence"],
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function computeMissing(subject: BookingSubject): string[] {
  const missing: string[] = [];
  if (!subject.patient_name) missing.push("patient_name");
  if (!subject.slot) missing.push("slot");
  if (!subject.service) missing.push("service");
  if (!subject.booking_contact) missing.push("booking_contact");
  return missing;
}

export function computeReadyForBooking(subject: BookingSubject): boolean {
  return subject.status !== "booked" && computeMissing(subject).length === 0;
}

function createSubject(id: SubjectId, role: "sender" | "mentioned_person", label?: string | null): BookingSubject {
  const s: BookingSubject = {
    id, role,
    label: label ?? null,
    patient_name: null,
    service: null,
    slot: null,
    booking_contact: null,
    status: "collecting",
    missing: [],
  };
  s.missing = computeMissing(s);
  return s;
}

function nextSubjectId(existing: BookingSubject[]): SubjectId | null {
  const usedNums = new Set(existing.map((s) => {
    const m = s.id.match(/^subject_(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }));
  for (let i = 1; i <= 4; i++) {
    if (!usedNums.has(i)) return `subject_${i}` as SubjectId;
  }
  return null;
}

// ── applySubjectIntent ────────────────────────────────────────────────────────

export function applySubjectIntent(state: BookingSubjectsState, intent: SubjectIntent): BookingSubjectsState {
  if (intent.confidence === "low") return state;
  if (intent.action === "none") return state;

  // start_new_episode: reset status and clear booked status on all subjects
  if (intent.action === "start_new_episode") {
    const subjects = state.subjects.map((s) => ({
      ...s,
      status: "collecting" as const,
      missing: computeMissing({ ...s, status: "collecting" as const }),
    }));
    return { ...state, status: "active", subjects };
  }

  const MAX = state.max_subjects;
  let { active_subject_id } = state;
  let subjects = [...state.subjects];

  if (intent.action === "switch_subject" || intent.action === "create_or_switch_subject") {
    if (intent.target === "self") {
      active_subject_id = "subject_1" as SubjectId;
    } else if (intent.target === "mentioned_person") {
      if (intent.subject_id && subjects.some((s) => s.id === intent.subject_id)) {
        active_subject_id = intent.subject_id;
        if (intent.display_name) {
          subjects = subjects.map((s) =>
            s.id === intent.subject_id && !s.patient_name
              ? { ...s, patient_name: intent.display_name! }
              : s,
          );
        }
      } else {
        const mp = subjects.find((s) => s.role === "mentioned_person");
        if (mp) {
          active_subject_id = mp.id;
          if (intent.display_name) {
            subjects = subjects.map((s) =>
              s.id === mp.id
                ? {
                    ...s,
                    label: s.label ?? intent.display_name!,
                    patient_name: s.patient_name ?? intent.display_name!,
                  }
                : s,
            );
          }
        } else if (intent.action === "create_or_switch_subject") {
          const newId = nextSubjectId(subjects);
          if (newId && subjects.length < MAX) {
            const newSubject = {
              ...createSubject(newId, "mentioned_person", intent.display_name ?? null),
              patient_name: intent.display_name ?? null,
            };
            newSubject.missing = computeMissing(newSubject);
            subjects = [...subjects, newSubject];
            active_subject_id = newId;
          }
        }
      }
    }
  } else if (intent.action === "create_subjects") {
    const intentLabels = intent.labels ?? [];
    let labelIdx = 0;

    const requestedCount = intent.count ?? 1;
    const singleTarget = requestedCount === 1 && intentLabels.length <= 1;
    subjects = subjects.map((s) => {
      if (s.role === "mentioned_person" && !s.label && labelIdx < intentLabels.length) {
        const updated = { ...s, label: intentLabels[labelIdx++] };
        if (singleTarget && intent.display_name && !updated.patient_name) {
          updated.patient_name = intent.display_name;
        }
        return updated;
      }
      return s;
    });

    const toCreate = Math.min(requestedCount - labelIdx, MAX - subjects.length);
    const singleDisplayName = toCreate === 1 ? (intent.display_name ?? null) : null;

    let firstCreatedId: SubjectId | null = null;
    for (let i = 0; i < toCreate; i++) {
      const newId = nextSubjectId(subjects);
      if (!newId) break;
      const label = labelIdx < intentLabels.length ? intentLabels[labelIdx++] : null;
      const newSubject = {
        ...createSubject(newId, "mentioned_person", label),
        patient_name: singleDisplayName,
      };
      newSubject.missing = computeMissing(newSubject);
      subjects = [...subjects, newSubject];
      if (!firstCreatedId) firstCreatedId = newId;
    }
    if (firstCreatedId) active_subject_id = firstCreatedId;
  }

  // Note: pending_typed_phone is NOT consumed here. Phone ownership is resolved
  // exclusively via applyPhoneOwnershipIntent (phone_ownership_intent from model).

  subjects = subjects.map((s) => ({ ...s, missing: computeMissing(s) }));
  return { ...state, active_subject_id, subjects };
}

// ── applyPhoneOwnershipIntent ─────────────────────────────────────────────────

export function applyPhoneOwnershipIntent(
  state: BookingSubjectsState,
  intent: PhoneOwnershipIntent,
): BookingSubjectsState {
  if (intent.confidence === "low") return state;
  if (intent.action === "none") return state;

  if (intent.action === "assign_pending_phone") {
    if (!state.pending_typed_phone) return state;
    const targetId = intent.target_subject_id ?? state.active_subject_id;
    let subjects = state.subjects.map((s) => {
      if (s.id !== targetId) return s;
      if (s.booking_contact?.trust === "trusted") return s;
      const bc: BookingContact = {
        phone_number: state.pending_typed_phone!,
        source: "typed",
        trust: "unverified",
        owner_subject_id: targetId,
        collected_at: new Date().toISOString(),
      };
      return { ...s, booking_contact: bc };
    });
    subjects = subjects.map((s) => ({ ...s, missing: computeMissing(s) }));
    return { ...state, subjects, pending_typed_phone: null };
  }

  if (intent.action === "share_sender_contact") {
    const targetId = intent.target_subject_id;
    if (!targetId) return state;
    const s1 = state.subjects.find((s) => s.id === "subject_1" as SubjectId);
    const senderContact = s1?.booking_contact;
    if (!senderContact || senderContact.trust !== "trusted") return state;
    let subjects = state.subjects.map((s) => {
      if (s.id !== targetId) return s;
      if (s.booking_contact?.trust === "trusted") return s;
      const bc: BookingContact = {
        phone_number: senderContact.phone_number,
        source: "shared_from_subject",
        trust: "trusted_contact_owner",
        owner_subject_id: "subject_1" as SubjectId,
        collected_at: new Date().toISOString(),
      };
      return { ...s, booking_contact: bc };
    });
    subjects = subjects.map((s) => ({ ...s, missing: computeMissing(s) }));
    return { ...state, subjects };
  }

  return state;
}

// ── v2→v3 migration helpers ───────────────────────────────────────────────────

function migrateV1Subject(sub: Record<string, unknown>, newId: SubjectId): BookingSubject {
  const role = sub.label === "mentioned_person" ? "mentioned_person" : "sender" as const;
  const phoneNum = typeof sub.phone_number === "string" ? sub.phone_number : null;
  const phoneSrc = typeof sub.phone_source === "string" ? sub.phone_source : null;
  const phoneStatus = sub.phone_status;

  let booking_contact: BookingContact | null = null;
  if (phoneNum) {
    if (phoneStatus === "trusted" && phoneSrc) {
      booking_contact = {
        phone_number: phoneNum,
        source: phoneSrc as BookingContactSource,
        trust: "trusted",
        owner_subject_id: newId,
        collected_at: null,
      };
    } else if (phoneStatus === "typed_unverified") {
      booking_contact = {
        phone_number: phoneNum,
        source: "typed",
        trust: "unverified",
        owner_subject_id: newId,
        collected_at: null,
      };
    }
  }

  const rawStatus = sub.status;
  const status: BookingSubject["status"] =
    rawStatus === "booked" ? "booked" :
    rawStatus === "ready" ? "ready_for_booking" : "collecting";

  const s: BookingSubject = {
    id: newId,
    role,
    label: null,
    patient_name: typeof sub.name === "string" ? sub.name : null,
    service: typeof sub.service === "string" ? sub.service : null,
    slot: typeof sub.slot === "string" ? sub.slot : null,
    booking_contact,
    status,
    missing: [],
  };
  s.missing = computeMissing(s);
  return s;
}

function validateV2Subject(raw: unknown): BookingSubject | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !SUBJECT_ID_RE.test(s.id)) return null;
  const id = s.id as SubjectId;
  const role = s.role === "mentioned_person" ? "mentioned_person" : "sender" as const;

  let booking_contact: BookingContact | null = null;
  if (s.booking_contact && typeof s.booking_contact === "object" && !Array.isArray(s.booking_contact)) {
    const bc = s.booking_contact as Record<string, unknown>;
    if (typeof bc.phone_number === "string" && typeof bc.source === "string" && typeof bc.trust === "string") {
      booking_contact = {
        phone_number: bc.phone_number,
        source: bc.source as BookingContactSource,
        trust: bc.trust as BookingContactTrust,
        owner_subject_id: typeof bc.owner_subject_id === "string" && SUBJECT_ID_RE.test(bc.owner_subject_id)
          ? (bc.owner_subject_id as SubjectId)
          : null,
        collected_at: typeof bc.collected_at === "string" ? bc.collected_at : null,
      };
    }
  }

  const rawStatus = s.status;
  const status: BookingSubject["status"] =
    rawStatus === "booked" ? "booked" :
    rawStatus === "ready_for_booking" ? "ready_for_booking" : "collecting";

  const subject: BookingSubject = {
    id,
    role,
    label: typeof s.label === "string" ? s.label : null,
    patient_name: typeof s.patient_name === "string" ? s.patient_name : null,
    service: typeof s.service === "string" ? s.service : null,
    slot: typeof s.slot === "string" ? s.slot : null,
    booking_contact,
    status,
    missing: [],
  };
  subject.missing = computeMissing(subject);
  return subject;
}

export function normalizeBookingSubjectsState(raw: unknown): BookingSubjectsState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  // v3 path
  if (r.version === 3) {
    const activeId = r.active_subject_id;
    if (typeof activeId !== "string" || !SUBJECT_ID_RE.test(activeId)) return null;
    const subjects = Array.isArray(r.subjects)
      ? r.subjects.map(validateV2Subject).filter((s): s is BookingSubject => s !== null)
      : [];
    if (subjects.length === 0) return null;
    // Verify active_subject_id points to an existing subject
    if (!subjects.some((s) => s.id === activeId)) return null;
    // Coerce status: accept both episode_status (old) and status (new)
    const rawStatus = r.status ?? r.episode_status;
    const status: "active" | "completed" = rawStatus === "completed" ? "completed" : "active";
    return {
      version: 3,
      status,
      active_subject_id: activeId as SubjectId,
      subjects,
      pending_typed_phone: typeof r.pending_typed_phone === "string" ? r.pending_typed_phone : null,
      max_subjects: 4,
    };
  }

  // v2 → v3 upgrade path
  if (r.version === 2) {
    const activeId = r.active_subject_id;
    if (typeof activeId !== "string" || !SUBJECT_ID_RE.test(activeId)) return null;
    const subjects = Array.isArray(r.subjects)
      ? r.subjects.map(validateV2Subject).filter((s): s is BookingSubject => s !== null)
      : [];
    if (subjects.length === 0) return null;
    if (!subjects.some((s) => s.id === activeId)) return null;
    return {
      version: 3,
      status: "active",
      active_subject_id: activeId as SubjectId,
      subjects,
      pending_typed_phone: typeof r.pending_typed_phone === "string" ? r.pending_typed_phone : null,
      max_subjects: 4,
    };
  }

  // v1 migration path
  const v1ActiveId = r.active_subject_id;
  if (v1ActiveId !== "s1" && v1ActiveId !== "s2") return null;
  if (!Array.isArray(r.subjects) || r.subjects.length === 0) return null;

  const ID_MAP: Record<string, SubjectId> = { s1: "subject_1" as SubjectId, s2: "subject_2" as SubjectId };
  const subjects = (r.subjects as unknown[])
    .map((s) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return null;
      const sub = s as Record<string, unknown>;
      if (sub.id !== "s1" && sub.id !== "s2") return null;
      return migrateV1Subject(sub, ID_MAP[sub.id as string]);
    })
    .filter((s): s is BookingSubject => s !== null);

  if (subjects.length === 0) return null;

  return {
    version: 3,
    status: "active",
    active_subject_id: ID_MAP[v1ActiveId],
    subjects,
    pending_typed_phone: typeof r.pending_typed_phone === "string" ? r.pending_typed_phone : null,
    max_subjects: 4,
  };
}

export function deserializeBookingSubjects(raw: unknown): BookingSubjectsState | null {
  return normalizeBookingSubjectsState(raw);
}

// ── pre-turn init (no regex — structured intent only) ─────────────────────────

/**
 * Prepare booking subjects state for a new turn.
 * - Returns null if no prior state exists (registry not yet active).
 * - Applies channel_contact to subject_1 when available.
 * - Typed phone goes to pending_typed_phone ONLY — never auto-assigned to active subject.
 *   Phone ownership is resolved by phone_ownership_intent from the model response.
 */
export function initBookingSubjectsForTurn(params: {
  current: BookingSubjectsState | null;
  channelContact: ChannelContact | null;
  pendingTypedPhone: string | null; // current-turn extracted typed phone only
}): BookingSubjectsState | null {
  const { current, channelContact, pendingTypedPhone } = params;

  if (!current) return null;

  const s1Trusted = channelContact != null && TRUSTED_PHONE_SOURCES.has(channelContact.phone_source);
  let subjects = current.subjects.map((s) => {
    if (s.id !== "subject_1" as SubjectId) return s;
    if (!channelContact?.phone_number) return s;
    if (s.booking_contact?.trust === "trusted") return s;
    const bc: BookingContact = {
      phone_number: channelContact.phone_number,
      source: channelContact.phone_source as BookingContactSource,
      trust: s1Trusted ? "trusted" : "unverified",
      owner_subject_id: "subject_1" as SubjectId,
      collected_at: null,
    };
    return { ...s, booking_contact: bc };
  });
  subjects = subjects.map((s) => ({ ...s, missing: computeMissing(s) }));

  const pending_typed_phone = pendingTypedPhone ?? current.pending_typed_phone;

  return { ...current, subjects, pending_typed_phone };
}

// ── Bootstrap state from intent (call when model emits create intent and no prior state) ──

/**
 * Create the initial booking subjects state from a subject_intent that signals subject creation.
 * Only called when there is no prior state and the model emits create_subjects / create_or_switch_subject.
 */
export function bootstrapBookingSubjectsFromIntent(
  intent: SubjectIntent,
  s1Seed?: S1Seed | null,
  channelContact?: ChannelContact | null,
): BookingSubjectsState | null {
  if (intent.action !== "create_subjects" && intent.action !== "create_or_switch_subject") return null;
  if (intent.confidence === "low") return null;

  const s1Trusted = channelContact != null && TRUSTED_PHONE_SOURCES.has(channelContact.phone_source);
  const s1Contact: BookingContact | null = channelContact?.phone_number
    ? {
        phone_number: channelContact.phone_number,
        source: channelContact.phone_source as BookingContactSource,
        trust: s1Trusted ? "trusted" : "unverified",
        owner_subject_id: "subject_1" as SubjectId,
        collected_at: null,
      }
    : null;

  const s1: BookingSubject = {
    ...createSubject("subject_1" as SubjectId, "sender"),
    patient_name: s1Seed?.name ?? null,
    service: s1Seed?.service ?? null,
    slot: s1Seed?.slot ?? null,
    booking_contact: s1Contact,
    missing: [],
  };
  s1.missing = computeMissing(s1);

  const base: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_1" as SubjectId,
    subjects: [s1],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  return applySubjectIntent(base, intent);
}

// ── post-turn update ──────────────────────────────────────────────────────────

export function postUpdateBookingSubjects(params: {
  current: BookingSubjectsState;
  toolRequests: RuntimeAgentToolRequest[];
  toolResults: RuntimeAgentToolResult[];
  subjectIntent?: SubjectIntent | null;
  phoneOwnershipIntent?: PhoneOwnershipIntent | null;
  /** Frozen execution subject from resolveBookingExecutionSubject() — always provide in production. Falls back to active_subject_id when null/undefined. */
  executionSubjectId?: SubjectId | null;
}): BookingSubjectsState {
  const { current, toolRequests, toolResults, subjectIntent, phoneOwnershipIntent, executionSubjectId } = params;

  let state = current;

  // Apply subject intent first (may change active_subject_id for next turn)
  if (subjectIntent) {
    state = applySubjectIntent(state, subjectIntent);
  }

  // Apply phone ownership intent (resolves pending_typed_phone to a subject)
  if (phoneOwnershipIntent) {
    state = applyPhoneOwnershipIntent(state, phoneOwnershipIntent);
  }

  // Apply booking.apply results to the subject that was frozen at execution time.
  // Falls back to current active_subject_id if no explicit freeze was provided.
  const effectiveSubjectId = executionSubjectId ?? state.active_subject_id;

  const applyReq = toolRequests.find((r) => r.tool === "booking.apply");
  const applyResult = toolResults.find((r) => r.tool === "booking.apply");
  const visitCreated = (applyResult?.data as Record<string, unknown> | undefined)?.created_visit === true;

  const firstName = typeof applyReq?.arguments.first_name === "string" ? applyReq.arguments.first_name.trim() : null;
  const lastName = typeof applyReq?.arguments.last_name === "string" ? applyReq.arguments.last_name.trim() : null;
  const appliedName = firstName && lastName ? `${firstName} ${lastName}` : (firstName ?? lastName ?? null);
  const appliedDate = typeof applyReq?.arguments.requested_date === "string" ? applyReq.arguments.requested_date.trim() : null;
  const appliedTime = typeof applyReq?.arguments.requested_time === "string" ? applyReq.arguments.requested_time.trim() : null;
  const appliedSlot = appliedDate && appliedTime ? `${appliedDate}T${appliedTime}` : null;
  const appliedService =
    typeof applyReq?.arguments.service === "string"
      ? applyReq.arguments.service.trim()
      : typeof applyReq?.arguments.service_reason === "string"
        ? applyReq.arguments.service_reason.trim()
        : null;

  let subjects = state.subjects.map((s) => {
    if (s.id !== effectiveSubjectId) return s;
    let updated = { ...s };
    if (appliedName) updated = { ...updated, patient_name: appliedName };
    if (appliedSlot) updated = { ...updated, slot: appliedSlot };
    if (appliedService) updated = { ...updated, service: appliedService };
    if (visitCreated) updated = { ...updated, status: "booked" as const };
    return updated;
  });

  // Auto-complete episode when all subjects are booked.
  const allBooked = subjects.length > 0 && subjects.every((s) => s.status === "booked");
  const nextStatus: "active" | "completed" = allBooked ? "completed" : state.status;

  const bookingApplyData = applyResult?.data as Record<string, unknown> | undefined;
  const blockedForPendingClassification = bookingApplyData?.booking_status === "pending_phone_classification";
  const hadPendingPhone = current.pending_typed_phone != null;
  const stillPendingAfterIntent = state.pending_typed_phone != null;
  const consumedByIntent = hadPendingPhone && !stillPendingAfterIntent;

  const nextPendingPhone = consumedByIntent
    ? null
    : blockedForPendingClassification
      ? current.pending_typed_phone
      : state.pending_typed_phone;

  subjects = subjects.map((s) => ({ ...s, missing: computeMissing(s) }));

  return {
    ...state,
    subjects,
    pending_typed_phone: nextPendingPhone,
    status: nextStatus,
  };
}

// ── subject mismatch detection ────────────────────────────────────────────────

export interface SubjectMismatch {
  active_subject_id: SubjectId;
  booking_apply_name: string | null;
  active_subject_name: string | null;
  mismatch: boolean;
}

export function detectSubjectMismatch(params: {
  state: BookingSubjectsState;
  toolRequests: RuntimeAgentToolRequest[];
  channelContact: ChannelContact | null;
  providedPhone: ProvidedPhone | null;
}): SubjectMismatch | null {
  const { state, toolRequests } = params;
  const applyReq = toolRequests.find((r) => r.tool === "booking.apply");
  if (!applyReq) return null;

  const firstName = typeof applyReq.arguments.first_name === "string" ? applyReq.arguments.first_name.trim() : null;
  const lastName = typeof applyReq.arguments.last_name === "string" ? applyReq.arguments.last_name.trim() : null;
  const bookingName = firstName && lastName ? `${firstName} ${lastName}` : (firstName ?? lastName ?? null);

  const activeSubject = state.subjects.find((s) => s.id === state.active_subject_id) ?? null;
  const activeName = activeSubject?.patient_name ?? null;

  const mismatch = state.active_subject_id === "subject_1" && params.providedPhone != null && params.channelContact == null;

  return { active_subject_id: state.active_subject_id, booking_apply_name: bookingName, active_subject_name: activeName, mismatch };
}

// ── model-visible context ─────────────────────────────────────────────────────

export function buildSubjectsContextPayload(state: BookingSubjectsState): Record<string, unknown> {
  return {
    version: 3,
    status: state.status,
    active_subject_id: state.active_subject_id,
    subjects: state.subjects.map((s) => ({
      id: s.id,
      label: s.label,
      patient_name: s.patient_name,
      service: s.service,
      slot: s.slot,
      phone_status: s.booking_contact
        ? s.booking_contact.trust === "trusted"
          ? "trusted"
          : s.booking_contact.trust === "trusted_contact_owner"
            ? "trusted_contact_owner"
            : "typed_unverified"
        : null,
      contact_owner:
        s.booking_contact == null
          ? null
          : (s.booking_contact.owner_subject_id === s.id || s.booking_contact.owner_subject_id == null)
            ? "self"
            : s.booking_contact.owner_subject_id,
      missing: s.missing,
      status: s.status,
    })),
    ...(state.pending_typed_phone ? { pending_typed_phone: state.pending_typed_phone } : {}),
    max_subjects: 4,
  };
}

import type { ChannelContact, ProvidedPhone } from "./openaiRuntimeAgent.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import { TRUSTED_PHONE_SOURCES } from "../integrations/cliniccard/bookingApplyExecutor.ts";

// ── v2 types ──────────────────────────────────────────────────────────────────

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
  version: 2;
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

// ── subject_intent v2 ─────────────────────────────────────────────────────────

export interface SubjectIntent {
  action: "none" | "switch_subject" | "create_subjects" | "create_or_switch_subject";
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

  if (!["none", "switch_subject", "create_subjects", "create_or_switch_subject"].includes(action)) return null;
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

  const MAX = state.max_subjects;
  let { active_subject_id, pending_typed_phone } = state;
  let subjects = [...state.subjects];
  const prevActiveId = active_subject_id;

  if (intent.action === "switch_subject" || intent.action === "create_or_switch_subject") {
    if (intent.target === "self") {
      active_subject_id = "subject_1" as SubjectId;
    } else if (intent.target === "mentioned_person") {
      if (intent.subject_id && subjects.some((s) => s.id === intent.subject_id)) {
        active_subject_id = intent.subject_id;
        // Fill patient_name from display_name if missing (Blocker 2 fix)
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
          // Fill label and patient_name from display_name if missing (Blocker 2 fix)
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
              patient_name: intent.display_name ?? null,  // Blocker 2 fix: persist display_name
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

    // Label existing unlabeled mentioned_person subjects first
    subjects = subjects.map((s) => {
      if (s.role === "mentioned_person" && !s.label && labelIdx < intentLabels.length) {
        return { ...s, label: intentLabels[labelIdx++] };
      }
      return s;
    });

    // Create only remaining subjects after labeling existing ones
    const requestedCount = intent.count ?? 1;
    const toCreate = Math.min(requestedCount - labelIdx, MAX - subjects.length);

    // display_name applied to patient_name when creating a single subject (Blocker 2 fix)
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

  // Resolve the phone target: intent.subject_id if valid, else derive from target/action.
  // Consume pending_typed_phone whenever intent confirms an owner — even if active didn't change.
  // (Bug fix: previous code required active_subject_id !== prevActiveId, which broke the case
  //  where the user confirms "номер мамы" while subject_2 is already active.)
  if (pending_typed_phone) {
    let phoneTargetId: SubjectId | null = null;
    if (intent.subject_id && subjects.some((s) => s.id === intent.subject_id)) {
      phoneTargetId = intent.subject_id;
    } else if (intent.target === "self") {
      phoneTargetId = "subject_1" as SubjectId;
    } else if (intent.target === "active" || intent.target === "mentioned_person") {
      phoneTargetId = active_subject_id;
    }
    if (phoneTargetId) {
      subjects = subjects.map((s) => {
        if (s.id !== phoneTargetId) return s;
        if (s.booking_contact?.trust === "trusted") return s;
        const bc: BookingContact = {
          phone_number: pending_typed_phone!,
          source: "typed",
          trust: "unverified",
          owner_subject_id: phoneTargetId!,
          collected_at: new Date().toISOString(),
        };
        return { ...s, booking_contact: bc };
      });
      pending_typed_phone = null;
    }
  }

  subjects = subjects.map((s) => ({ ...s, missing: computeMissing(s) }));
  return { ...state, active_subject_id, subjects, pending_typed_phone };
}

// ── switch signal detection (bounded regex fallback) ─────────────────────────

const SELF_SWITCH_PATTERNS = [
  /пока\s+меня/i,
  /тогда\s+меня/i,
  /давайте\s+меня/i,
  /запишите?\s+меня(?!\s+и\s+(маму|папу|брата|сестру|мужа|жену|друга|подругу|ребёнка|дочку|сына|его|её))/i,
  /ладно\s+меня/i,
  /лучше\s+меня/i,
  /ну\s+меня/i,
  /тогда\s+я\b/i,
  /^меня$/i,
];

const THIRD_PARTY_CREATE_REGEXPS: RegExp[] = [
  /запишите?\s+(?!меня\b|мне\b|я\b)(\S+)/i,
  /ещё\s+(?:одного|одну|человека|пациент\w*)/i,
  /(?:тоже|также)\s+запишите?/i,
  /запишите?\s+(?:ещё|и\s+ещё)/i,
  // \b doesn't fire on Cyrillic — keep original as dead code (doesn't match anything harmful)
  /\b(его|её|парня|брата|сестру|маму|папу|друга|подругу|мужа|жену|ребёнка|дочку|сына)\b\s+тоже/i,
  /запишите?\s+(его|её|парня|брата|сестру|маму|папу|друга|подругу|мужа|жену)(\s|$)/i,
  /запишите?\s+меня\s+и\s+(маму|папу|брата|сестру|мужа|жену|друга|подругу)/i,
  /тоже\s+(?:надо|нужно)?\s*запишите?/i,
  // "и маму/папу/etc" — use space anchors since \b won't cross Cyrillic boundary
  /(^|\s)и\s+(его|её|парня|брата|друга|сестру|маму|папу)(\s|$)/i,
];

const THIRD_PARTY_SWITCH_REGEXPS: RegExp[] = [
  /(^|\s)(его|её|парня|брата|сестру|маму|папу|друга|подругу|мужа|жену)(\s|$|[?,.])/i,
  /для\s+(?:него|неё)/i,
];

export type SwitchSignal = "self" | "third_party_create" | "third_party_switch" | null;

export function detectSwitchSignal(text: string, existingMentionedName?: string | null): SwitchSignal {
  for (const p of SELF_SWITCH_PATTERNS) {
    if (p.test(text)) return "self";
  }
  for (const p of THIRD_PARTY_CREATE_REGEXPS) {
    if (p.test(text)) return "third_party_create";
  }
  if (existingMentionedName) {
    const firstName = existingMentionedName.split(" ")[0];
    if (firstName && firstName.length >= 3) {
      const stem = firstName.slice(0, -1).toLowerCase();
      const textLow = text.toLowerCase();
      const idx = textLow.indexOf(stem);
      if (idx !== -1) {
        const isCyrillic = (c: string | undefined) => c !== undefined && /[а-яёА-ЯЁa-zA-Z0-9]/u.test(c);
        if (!isCyrillic(textLow[idx - 1]) || !isCyrillic(textLow[idx + stem.length])) {
          return "third_party_switch";
        }
      }
    }
  }
  for (const p of THIRD_PARTY_SWITCH_REGEXPS) {
    if (p.test(text)) return "third_party_switch";
  }
  return null;
}

// ── v1 → v2 migration ────────────────────────────────────────────────────────

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

  // v2 path
  if (r.version === 2) {
    const activeId = r.active_subject_id;
    if (typeof activeId !== "string" || !SUBJECT_ID_RE.test(activeId)) return null;
    const subjects = Array.isArray(r.subjects)
      ? r.subjects.map(validateV2Subject).filter((s): s is BookingSubject => s !== null)
      : [];
    if (subjects.length === 0) return null;
    return {
      version: 2,
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
    version: 2,
    active_subject_id: ID_MAP[v1ActiveId],
    subjects,
    pending_typed_phone: typeof r.pending_typed_phone === "string" ? r.pending_typed_phone : null,
    max_subjects: 4,
  };
}

export function deserializeBookingSubjects(raw: unknown): BookingSubjectsState | null {
  return normalizeBookingSubjectsState(raw);
}

// ── pre-turn update ───────────────────────────────────────────────────────────

export function preUpdateBookingSubjects(params: {
  current: BookingSubjectsState | null;
  userMessage: string;
  channelContact: ChannelContact | null;
  providedPhone: ProvidedPhone | null;
  s1Seed?: S1Seed | null;
}): BookingSubjectsState | null {
  const { current, userMessage, channelContact, providedPhone, s1Seed } = params;

  const currentV2 = current ? (normalizeBookingSubjectsState(current) ?? null) : null;

  const existingMentionedName = currentV2?.subjects.find((s) => s.role === "mentioned_person")?.patient_name ?? null;
  const signal = detectSwitchSignal(userMessage, existingMentionedName);

  const hasMentionedPerson = currentV2?.subjects.some((s) => s.role === "mentioned_person") ?? false;
  const hasSecondPersonSignal =
    signal === "third_party_create" ||
    signal === "third_party_switch" ||
    hasMentionedPerson;

  if (!hasSecondPersonSignal) return null;

  const state: BookingSubjectsState = currentV2 ?? {
    version: 2,
    active_subject_id: "subject_1" as SubjectId,
    subjects: [
      {
        ...createSubject("subject_1" as SubjectId, "sender"),
        patient_name: s1Seed?.name ?? null,
        service: s1Seed?.service ?? null,
        slot: s1Seed?.slot ?? null,
        missing: [],
      },
    ],
    pending_typed_phone: null,
    max_subjects: 4,
  };

  let subjects = [...state.subjects];
  let activeId: SubjectId = state.active_subject_id;

  // Create subject_2 from text signal if no mentioned_person exists yet
  if (signal === "third_party_create" && !subjects.some((s) => s.role === "mentioned_person")) {
    const newId = nextSubjectId(subjects);
    if (newId && subjects.length < state.max_subjects) {
      subjects = [...subjects, createSubject(newId, "mentioned_person")];
    }
  }

  // Determine active subject
  if (signal === "self") {
    activeId = "subject_1" as SubjectId;
  } else if (signal === "third_party_create" || signal === "third_party_switch") {
    const mp = subjects.find((s) => s.role === "mentioned_person");
    if (mp) activeId = mp.id;
  }

  // Apply channel contact to subject_1
  const s1Trusted = channelContact != null && TRUSTED_PHONE_SOURCES.has(channelContact.phone_source);
  subjects = subjects.map((s) => {
    if (s.id !== "subject_1") return s;
    if (!channelContact?.phone_number) return s;
    if (s.booking_contact?.trust === "trusted") return s; // don't downgrade
    const bc: BookingContact = {
      phone_number: channelContact.phone_number,
      source: channelContact.phone_source as BookingContactSource,
      trust: s1Trusted ? "trusted" : "unverified",
      owner_subject_id: "subject_1" as SubjectId,
      collected_at: null,
    };
    return { ...s, booking_contact: bc };
  });

  // Assign current-turn typed phone to active subject if it has no contact
  if (providedPhone) {
    subjects = subjects.map((s) => {
      if (s.id !== activeId) return s;
      if (s.booking_contact?.trust === "trusted") return s;
      const bc: BookingContact = {
        phone_number: providedPhone.phone_number,
        source: "typed",
        trust: "unverified",
        owner_subject_id: activeId,
        collected_at: new Date().toISOString(),
      };
      return { ...s, booking_contact: bc };
    });
  }

  subjects = subjects.map((s) => ({ ...s, missing: computeMissing(s) }));

  const pending_typed_phone = providedPhone?.phone_number ?? currentV2?.pending_typed_phone ?? null;

  return { version: 2, active_subject_id: activeId, subjects, pending_typed_phone, max_subjects: 4 };
}

// ── post-turn update ──────────────────────────────────────────────────────────

export function postUpdateBookingSubjects(params: {
  current: BookingSubjectsState;
  toolRequests: RuntimeAgentToolRequest[];
  toolResults: RuntimeAgentToolResult[];
  subjectIntent?: SubjectIntent | null;
}): BookingSubjectsState {
  const { current, toolRequests, toolResults, subjectIntent } = params;

  let state = current;
  if (subjectIntent) {
    state = applySubjectIntent(state, subjectIntent);
  }

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

  const activeId = state.active_subject_id;
  let subjects = state.subjects.map((s) => {
    if (s.id !== activeId) return s;
    let updated = { ...s };
    if (appliedName) updated = { ...updated, patient_name: appliedName };
    if (appliedSlot) updated = { ...updated, slot: appliedSlot };
    if (appliedService) updated = { ...updated, service: appliedService };
    if (visitCreated) updated = { ...updated, status: "booked" as const };
    return updated;
  });

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

  return { ...state, subjects, pending_typed_phone: nextPendingPhone };
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
    version: 2,
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

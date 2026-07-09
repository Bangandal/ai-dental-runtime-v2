import type { ChannelContact, ProvidedPhone } from "./openaiRuntimeAgent.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";
import { TRUSTED_PHONE_SOURCES } from "../integrations/cliniccard/bookingApplyExecutor.ts";

export type SubjectPhoneStatus = "trusted" | "typed_unverified" | null;
export type SubjectBookingStatus = "collecting" | "ready" | "booked";

export interface BookingSubject {
  id: "s1" | "s2";
  label: "sender" | "mentioned_person";
  name: string | null;
  service: string | null;
  slot: string | null;
  phone_number: string | null;
  phone_source: string | null;  // "telegram_contact_button" | "typed" | null
  phone_status: SubjectPhoneStatus;
  status: SubjectBookingStatus;
}

export interface BookingSubjectsState {
  active_subject_id: "s1" | "s2";
  subjects: BookingSubject[];
  /** Typed phone received this turn, visible to model so it can classify whose it is via subject_intent. */
  pending_typed_phone: string | null;
}

export interface S1Seed {
  name: string | null;
  service: string | null;
  slot: string | null;
}

// ── subject_intent (model-produced, multi-language subject switching) ───────

export interface SubjectIntent {
  action: "none" | "switch_subject" | "create_subject" | "create_or_switch_subject";
  target: "self" | "mentioned_person" | "active";
  display_name?: string | null;
  confidence: "low" | "medium" | "high";
}

export function parseSubjectIntent(raw: unknown): SubjectIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const action = r.action;
  const target = r.target;
  const confidence = r.confidence;
  if (!["none", "switch_subject", "create_subject", "create_or_switch_subject"].includes(action as string)) return null;
  if (!["self", "mentioned_person", "active"].includes(target as string)) return null;
  if (!["low", "medium", "high"].includes(confidence as string)) return null;
  return {
    action: action as SubjectIntent["action"],
    target: target as SubjectIntent["target"],
    display_name: typeof r.display_name === "string" ? r.display_name : null,
    confidence: confidence as SubjectIntent["confidence"],
  };
}

export function applySubjectIntent(state: BookingSubjectsState, intent: SubjectIntent): BookingSubjectsState {
  // Only apply medium/high confidence intent — low is too uncertain to act on
  if (intent.confidence === "low") return state;
  if (intent.action === "none") return state;

  let { active_subject_id, subjects, pending_typed_phone } = state;

  if (intent.action === "switch_subject" || intent.action === "create_or_switch_subject") {
    if (intent.target === "self") {
      active_subject_id = "s1";
    } else if (intent.target === "mentioned_person") {
      if (subjects.some((s) => s.id === "s2")) {
        active_subject_id = "s2";
      } else if (intent.action === "create_or_switch_subject") {
        const newS2 = { ...createSubject("s2", "mentioned_person"), name: intent.display_name ?? null };
        subjects = [...subjects, newS2];
        active_subject_id = "s2";
      }
    }
  } else if (intent.action === "create_subject") {
    if (intent.target === "mentioned_person" && !subjects.some((s) => s.id === "s2")) {
      const newS2 = { ...createSubject("s2", "mentioned_person"), name: intent.display_name ?? null };
      subjects = [...subjects, newS2];
      active_subject_id = "s2";
    }
  }

  // If the intent clarified a pending typed phone, assign it to the new active subject
  if (pending_typed_phone && active_subject_id !== state.active_subject_id) {
    subjects = subjects.map((s) => {
      if (s.id !== active_subject_id) return s;
      // Don't overwrite a trusted phone with typed
      if (s.phone_status === "trusted") return s;
      return { ...s, phone_number: pending_typed_phone, phone_source: "typed", phone_status: "typed_unverified" as SubjectPhoneStatus };
    });
    pending_typed_phone = null;  // consumed
  }

  return { active_subject_id, subjects, pending_typed_phone };
}

// ── switch signal detection ────────────────────────────────────────────────

const SELF_SWITCH_PATTERNS = [
  /пока\s+меня/i,
  /тогда\s+меня/i,
  /давайте\s+меня/i,
  /запишите?\s+меня/i,
  /ладно\s+меня/i,
  /лучше\s+меня/i,
  /ну\s+меня/i,
  /тогда\s+я\b/i,
  /^меня$/i,
];

// Signals that a DIFFERENT person should be booked — strong enough to create s2 without phone.
const THIRD_PARTY_PRONOUNS = /\b(его|её|парня|брата|сестру|маму|папу|друга|подругу|мужа|жену|ребёнка|дочку|сына)\b/i;
const THIRD_PARTY_CREATE_PATTERNS = [
  /запишите?\s+(?!меня\b|мне\b|я\b)(\S+)/i,
  /ещё\s+(?:одного|одну|человека|пациент\w*|раз)/i,
  /(?:тоже|также)\s+запишите?/i,
  /запишите?\s+(?:ещё|и\s+ещё)/i,
  new RegExp(THIRD_PARTY_PRONOUNS.source + "\\s+(?:тоже|запишите?|записать|записи)", "i"),
  /запишите?\s+/ + THIRD_PARTY_PRONOUNS.source,
];
// Rebuild correctly (avoid concatenating regex with string)
const THIRD_PARTY_CREATE_REGEXPS: RegExp[] = [
  /запишите?\s+(?!меня\b|мне\b|я\b)(\S+)/i,
  /ещё\s+(?:одного|одну|человека|пациент\w*)/i,
  /(?:тоже|также)\s+запишите?/i,
  /запишите?\s+(?:ещё|и\s+ещё)/i,
  /\b(его|её|парня|брата|сестру|маму|папу|друга|подругу|мужа|жену|ребёнка|дочку|сына)\b\s+тоже/i,
  /запишите?\s+\b(его|её|парня|брата|сестру|маму|папу|друга|подругу|мужа|жену)\b/i,
  /\bтоже\s+(?:надо|нужно)?\s*запишите?/i,
  /\bи\s+(?:его|её|парня|брата|друга|сестру|маму|папу)\b/i,
];

// Signals to switch to an already-existing s2 (do NOT create new s2 from these alone).
// Note: \b doesn't work for Cyrillic in JS regex; these short pronouns match naturally
// since they appear surrounded by spaces in Russian sentences.
const THIRD_PARTY_SWITCH_REGEXPS: RegExp[] = [
  /(^|\s)(его|её|парня|брата|сестру|маму|папу|друга|подругу|мужа|жену)(\s|$|[?,.])/i,
  /для\s+(?:него|неё)/i,
];

export type SwitchSignal = "self" | "third_party_create" | "third_party_switch" | null;

export function detectSwitchSignal(text: string, existingS2Name?: string | null): SwitchSignal {
  // Self-switch always wins if present
  for (const p of SELF_SWITCH_PATTERNS) {
    if (p.test(text)) return "self";
  }

  // Third-party creation — strong enough to bootstrap s2
  for (const p of THIRD_PARTY_CREATE_REGEXPS) {
    if (p.test(text)) return "third_party_create";
  }

  // Switch to existing s2 — only if s2 already has a name that appears in text
  if (existingS2Name) {
    // Match first name allowing for Russian declension (strip last char as stem).
    // Use simple substring check — \b doesn't work for Cyrillic in JS regex.
    const firstName = existingS2Name.split(" ")[0];
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
  // Generic pronouns → switch to existing s2
  for (const p of THIRD_PARTY_SWITCH_REGEXPS) {
    if (p.test(text)) return "third_party_switch";
  }

  return null;
}

// ── subject helpers ────────────────────────────────────────────────────────

function createSubject(id: "s1" | "s2", label: "sender" | "mentioned_person"): BookingSubject {
  return { id, label, name: null, service: null, slot: null, phone_number: null, phone_source: null, phone_status: null, status: "collecting" };
}

export function computeMissing(subject: BookingSubject): string[] {
  const missing: string[] = [];
  if (!subject.name) missing.push("name");
  if (!subject.slot) missing.push("slot");
  if (!subject.service) missing.push("service");
  if (!subject.phone_number) missing.push("phone");
  return missing;
}

export function computeReadyForBooking(subject: BookingSubject): boolean {
  return subject.status !== "booked" && computeMissing(subject).length === 0;
}

// ── serialization ──────────────────────────────────────────────────────────

export function deserializeBookingSubjects(raw: unknown): BookingSubjectsState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const activeId = r.active_subject_id;
  if (activeId !== "s1" && activeId !== "s2") return null;
  const subjects = Array.isArray(r.subjects)
    ? (r.subjects as unknown[])
        .map((s) => {
          if (!s || typeof s !== "object" || Array.isArray(s)) return null;
          const sub = s as Record<string, unknown>;
          if (sub.id !== "s1" && sub.id !== "s2") return null;
          return {
            id: sub.id as "s1" | "s2",
            label: sub.label === "mentioned_person" ? "mentioned_person" : ("sender" as const),
            name: typeof sub.name === "string" ? sub.name : null,
            service: typeof sub.service === "string" ? sub.service : null,
            slot: typeof sub.slot === "string" ? sub.slot : null,
            phone_number: typeof sub.phone_number === "string" ? sub.phone_number : null,
            phone_source: typeof sub.phone_source === "string" ? sub.phone_source : null,
            phone_status: (sub.phone_status === "trusted" || sub.phone_status === "typed_unverified") ? sub.phone_status : null,
            status: (sub.status === "booked" || sub.status === "ready") ? sub.status : ("collecting" as const),
          } satisfies BookingSubject;
        })
        .filter((s): s is BookingSubject => s !== null)
    : [];
  if (subjects.length === 0) return null;
  const pendingTypedPhone = typeof r.pending_typed_phone === "string" ? r.pending_typed_phone : null;
  return { active_subject_id: activeId, subjects, pending_typed_phone: pendingTypedPhone };
}

// ── pre-turn update (before model call) ───────────────────────────────────

export function preUpdateBookingSubjects(params: {
  current: BookingSubjectsState | null;
  userMessage: string;
  channelContact: ChannelContact | null;
  providedPhone: ProvidedPhone | null;
  s1Seed?: S1Seed | null;
}): BookingSubjectsState | null {
  const { current, userMessage, channelContact, providedPhone, s1Seed } = params;

  const existingS2Name = current?.subjects.find((s) => s.id === "s2")?.name ?? null;
  const signal = detectSwitchSignal(userMessage, existingS2Name);

  // Typed phone alone does NOT trigger subjects state — handled by single-subject provided_phone flow.
  // State is only created/maintained when there are actual multi-person signals.
  const hasSecondPersonSignal =
    signal === "third_party_create" ||
    signal === "third_party_switch" ||
    (current !== null && current.subjects.some((s) => s.id === "s2"));

  if (!hasSecondPersonSignal) return null;

  // Bootstrap state with s1 seeded from existing booking data (if we have it)
  const state: BookingSubjectsState = current ?? {
    active_subject_id: "s1",
    subjects: [
      {
        ...createSubject("s1", "sender"),
        name: s1Seed?.name ?? null,
        service: s1Seed?.service ?? null,
        slot: s1Seed?.slot ?? null,
      },
    ],
    pending_typed_phone: null,
  };

  let s1 = state.subjects.find((s) => s.id === "s1") ?? createSubject("s1", "sender");
  let s2 = state.subjects.find((s) => s.id === "s2") ?? null;

  // Create s2 only from text signals — typed phone alone does not create s2
  if (signal === "third_party_create" && !s2) {
    s2 = createSubject("s2", "mentioned_person");
  }

  // Determine active subject
  let activeId: "s1" | "s2" = state.active_subject_id;
  if (signal === "self") {
    activeId = "s1";
  } else if (signal === "third_party_create") {
    activeId = "s2";
  } else if (signal === "third_party_switch" && s2) {
    activeId = "s2";
  }
  // No more: "else if (providedPhone && !current) { activeId = s2 }"

  // s1 always gets channelContact (trusted phone overrides any typed)
  const s1Trusted = channelContact != null && TRUSTED_PHONE_SOURCES.has(channelContact.phone_source);
  s1 = {
    ...s1,
    phone_number: channelContact?.phone_number ?? s1.phone_number,
    phone_source: channelContact?.phone_source ?? s1.phone_source,
    phone_status: s1Trusted ? "trusted" : s1.phone_status,
  };

  // Assign typed phone to active subject (trusted phone for s1 wins if present)
  if (providedPhone) {
    if (activeId === "s1" && !s1Trusted) {
      s1 = { ...s1, phone_number: providedPhone.phone_number, phone_source: "typed", phone_status: "typed_unverified" };
    } else if (activeId === "s2" && s2) {
      s2 = { ...s2, phone_number: providedPhone.phone_number, phone_source: "typed", phone_status: "typed_unverified" };
    }
  }

  const subjects: BookingSubject[] = s2 ? [s1, s2] : [s1];
  // Store pending_typed_phone so model can see it and potentially reassign via subject_intent
  const pending_typed_phone = providedPhone?.phone_number ?? null;
  return { active_subject_id: activeId, subjects, pending_typed_phone };
}

// ── post-turn update (after model call) ───────────────────────────────────

export function postUpdateBookingSubjects(params: {
  current: BookingSubjectsState;
  toolRequests: RuntimeAgentToolRequest[];
  toolResults: RuntimeAgentToolResult[];
  modelDebug?: Record<string, unknown> | null;
}): BookingSubjectsState {
  const { current, toolRequests, toolResults, modelDebug } = params;

  // Apply subject_intent from model output (multi-language subject switching)
  let state = current;
  const rawIntent = modelDebug?.subject_intent;
  if (rawIntent) {
    const intent = parseSubjectIntent(rawIntent);
    if (intent) {
      state = applySubjectIntent(state, intent);
    }
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
  const subjects = state.subjects.map((s) => {
    if (s.id !== activeId) return s;
    let updated = { ...s };
    if (appliedName) updated = { ...updated, name: appliedName };
    if (appliedSlot) updated = { ...updated, slot: appliedSlot };
    if (appliedService) updated = { ...updated, service: appliedService };
    if (visitCreated) updated = { ...updated, status: "booked" as SubjectBookingStatus };
    return updated;
  });

  // Clear pending_typed_phone — it's been either consumed by subject_intent or assigned by pre-turn
  return { ...state, subjects, pending_typed_phone: null };
}

// ── active-subject vs booking.apply mismatch detection ────────────────────

export interface SubjectMismatch {
  active_subject_id: "s1" | "s2";
  booking_apply_name: string | null;
  active_subject_name: string | null;
  mismatch: boolean;
}

/**
 * Returns mismatch info when booking.apply is for active subject but the
 * phone context doesn't match. With subject-aware execution context (#173),
 * this serves as a debug signal showing when the guard would have been needed.
 */
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
  const activeName = activeSubject?.name ?? null;

  // Mismatch: active=s1 (sender) but only a provided_phone exists (no channel_contact).
  // With subject-aware execution this is handled correctly, but we still log it for debug.
  const mismatch = state.active_subject_id === "s1" && params.providedPhone != null && params.channelContact == null;

  return { active_subject_id: state.active_subject_id, booking_apply_name: bookingName, active_subject_name: activeName, mismatch };
}

// ── model-visible context injection ───────────────────────────────────────

export function buildSubjectsContextPayload(state: BookingSubjectsState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    active_subject_id: state.active_subject_id,
    subjects: state.subjects.map((s) => ({
      id: s.id,
      label: s.label,
      name: s.name,
      service: s.service,
      slot: s.slot,
      phone_number: s.phone_number,
      phone_source: s.phone_source,
      phone_status: s.phone_status,
      status: s.status,
      missing: computeMissing(s),
      ready_for_booking: computeReadyForBooking(s),
    })),
  };
  if (state.pending_typed_phone) {
    payload.pending_typed_phone = state.pending_typed_phone;
  }
  return payload;
}

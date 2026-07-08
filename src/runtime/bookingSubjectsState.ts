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
  phone_status: SubjectPhoneStatus;
  status: SubjectBookingStatus;
}

export interface BookingSubjectsState {
  active_subject_id: "s1" | "s2";
  subjects: BookingSubject[];
}

// ── switch signal detection ────────────────────────────────────────────────

const SELF_SWITCH_PATTERNS = [
  /пока\s+меня/i,
  /тогда\s+меня/i,
  /давайте\s+меня/i,
  /запишите\s+меня/i,
  /ладно\s+меня/i,
  /лучше\s+меня/i,
  /ну\s+меня/i,
  /тогда\s+я\b/i,
  /^меня$/i,
];

export function detectSwitchSignal(text: string): "self" | null {
  for (const pattern of SELF_SWITCH_PATTERNS) {
    if (pattern.test(text)) return "self";
  }
  return null;
}

// ── subject helpers ────────────────────────────────────────────────────────

function createSubject(id: "s1" | "s2", label: "sender" | "mentioned_person"): BookingSubject {
  return { id, label, name: null, service: null, slot: null, phone_number: null, phone_status: null, status: "collecting" };
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
            phone_status: (sub.phone_status === "trusted" || sub.phone_status === "typed_unverified") ? sub.phone_status : null,
            status: (sub.status === "booked" || sub.status === "ready") ? sub.status : ("collecting" as const),
          } satisfies BookingSubject;
        })
        .filter((s): s is BookingSubject => s !== null)
    : [];
  if (subjects.length === 0) return null;
  return { active_subject_id: activeId, subjects };
}

// ── pre-turn update (before model call) ───────────────────────────────────
// Applies: switch signal from user message, phone status from contacts.
// Does NOT touch name/slot/service — those come from booking.apply args (post-turn).

export function preUpdateBookingSubjects(params: {
  current: BookingSubjectsState | null;
  userMessage: string;
  channelContact: ChannelContact | null;
  providedPhone: ProvidedPhone | null;
}): BookingSubjectsState | null {
  const { current, userMessage, channelContact, providedPhone } = params;

  // Only activate subjects state when a second person appears (typed phone = definitive signal).
  if (!providedPhone && current === null) return null;

  // Bootstrap state if not yet present.
  const state: BookingSubjectsState = current ?? {
    active_subject_id: "s1",
    subjects: [createSubject("s1", "sender")],
  };

  let s1 = state.subjects.find((s) => s.id === "s1") ?? createSubject("s1", "sender");
  let s2 = state.subjects.find((s) => s.id === "s2") ?? null;

  // Create s2 lazily when provided_phone first appears.
  if (providedPhone && !s2) {
    s2 = createSubject("s2", "mentioned_person");
  }

  // Determine active subject — switch signal overrides.
  const signal = detectSwitchSignal(userMessage);
  let activeId: "s1" | "s2" = state.active_subject_id;
  if (signal === "self") activeId = "s1";
  else if (providedPhone && !current) activeId = "s2"; // first typed phone → switch to s2

  // Update phone status from contacts.
  const s1Phone = channelContact?.phone_number ?? null;
  const s1PhoneStatus: SubjectPhoneStatus = channelContact && TRUSTED_PHONE_SOURCES.has(channelContact.phone_source)
    ? "trusted"
    : null;
  s1 = { ...s1, phone_number: s1Phone, phone_status: s1PhoneStatus };

  if (s2) {
    const s2Phone = providedPhone?.phone_number ?? s2.phone_number;
    const s2PhoneStatus: SubjectPhoneStatus = providedPhone ? "typed_unverified" : s2.phone_status;
    s2 = { ...s2, phone_number: s2Phone, phone_status: s2PhoneStatus };
  }

  const subjects: BookingSubject[] = s2 ? [s1, s2] : [s1];
  return { active_subject_id: activeId, subjects };
}

// ── post-turn update (after model call) ───────────────────────────────────
// Applies: booking.apply args (name, slot, service), visit_created → booked.

export function postUpdateBookingSubjects(params: {
  current: BookingSubjectsState;
  toolRequests: RuntimeAgentToolRequest[];
  toolResults: RuntimeAgentToolResult[];
}): BookingSubjectsState {
  const { current, toolRequests, toolResults } = params;

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

  const activeId = current.active_subject_id;
  const subjects = current.subjects.map((s) => {
    if (s.id !== activeId) return s;
    let updated = { ...s };
    if (appliedName) updated = { ...updated, name: appliedName };
    if (appliedSlot) updated = { ...updated, slot: appliedSlot };
    if (appliedService) updated = { ...updated, service: appliedService };
    if (visitCreated) updated = { ...updated, status: "booked" as SubjectBookingStatus };
    return updated;
  });

  return { ...current, subjects };
}

// ── model-visible context injection ───────────────────────────────────────

export function buildSubjectsContextPayload(state: BookingSubjectsState): Record<string, unknown> {
  return {
    active_subject_id: state.active_subject_id,
    subjects: state.subjects.map((s) => ({
      id: s.id,
      label: s.label,
      name: s.name,
      service: s.service,
      slot: s.slot,
      phone_number: s.phone_number,
      phone_status: s.phone_status,
      status: s.status,
      missing: computeMissing(s),
      ready_for_booking: computeReadyForBooking(s),
    })),
  };
}

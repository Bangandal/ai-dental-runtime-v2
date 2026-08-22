import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import type { ProvidedPhone, RuntimeAgentToolRequest } from "./openaiRuntimeAgent.ts";
import type {
  BookingContact,
  BookingSubject,
  BookingSubjectsState,
  SubjectId,
} from "./bookingSubjectsState.ts";

const CANONICAL_PHONE_RE = /^\+?\d{9,15}$/;

/**
 * Agent-first phone boundary.
 *
 * The model owns understanding and normalization of patient language. Runtime deliberately
 * does not strip words, spaces, punctuation or infer a country code here. It accepts only an
 * already-normalized phone value and records its provenance as patient-provided/unverified.
 */
export function deriveAgentFirstProvidedPhone(
  request: RuntimeAgentToolRequest | null,
  now: Date,
): ProvidedPhone | null {
  if (!isAgentFirstRuntimeEnabled()) return null;
  if (!request || request.tool !== "booking.apply") return null;

  const raw = request.arguments.phone_number;
  if (typeof raw !== "string") return null;
  const phone = raw.trim();
  if (!CANONICAL_PHONE_RE.test(phone)) return null;

  return {
    phone_number: phone,
    phone_source: "typed",
    phone_trust: "unverified",
    phone_consent: false,
    phone_collected_at: now.toISOString(),
  };
}

function buildContact(phone: ProvidedPhone, subjectId: SubjectId): BookingContact {
  return {
    phone_number: phone.phone_number,
    source: "typed",
    trust: "unverified",
    owner_subject_id: subjectId,
    collected_at: phone.phone_collected_at,
  };
}

/**
 * Persist model-owned contact data in the same per-subject state already used by Runtime.
 * The phone is attached only after the execution subject has been deterministically frozen;
 * it can never choose or change patient identity.
 */
export function attachAgentFirstPhoneToExecutionSubject(params: {
  state: BookingSubjectsState | null;
  execution_subject_id: SubjectId | null;
  phone: ProvidedPhone | null;
}): BookingSubjectsState | null {
  const { state, execution_subject_id: subjectId, phone } = params;
  if (!isAgentFirstRuntimeEnabled() || !state || !subjectId || !phone) return state;

  // A different unresolved legacy phone must not be silently reclassified.
  if (state.pending_typed_phone && state.pending_typed_phone !== phone.phone_number) return state;

  let found = false;
  const subjects = state.subjects.map((subject) => {
    if (subject.id !== subjectId) return subject;
    found = true;
    return {
      ...subject,
      booking_contact: buildContact(phone, subjectId),
    } satisfies BookingSubject;
  });
  if (!found) return state;

  return {
    ...state,
    subjects,
    pending_typed_phone: state.pending_typed_phone === phone.phone_number
      ? null
      : state.pending_typed_phone,
  };
}

/**
 * Single-person bookings historically had no booking_subjects registry. In agent-first mode
 * we create a minimal subject_1 state when the model provides a booking contact so the value
 * is persisted/auditable without resurrecting free-text regex extraction in the orchestrator.
 */
export function bootstrapAgentFirstSelfSubjectForPhone(params: {
  booking_apply: RuntimeAgentToolRequest | null;
  existing_state: BookingSubjectsState | null;
  phone: ProvidedPhone | null;
}): BookingSubjectsState | null {
  const { booking_apply: request, existing_state: existing, phone } = params;
  if (!isAgentFirstRuntimeEnabled() || existing || !request || !phone) return existing;
  if (request.tool !== "booking.apply" || request.arguments.subject_id !== "subject_1") return existing;

  const firstName = typeof request.arguments.first_name === "string" ? request.arguments.first_name.trim() : "";
  const lastName = typeof request.arguments.last_name === "string" ? request.arguments.last_name.trim() : "";
  const patientName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const service = typeof request.arguments.service === "string" ? request.arguments.service.trim() || null : null;
  const date = typeof request.arguments.requested_date === "string" ? request.arguments.requested_date.trim() : "";
  const time = typeof request.arguments.requested_time === "string" ? request.arguments.requested_time.trim() : "";
  const slot = date && time ? `${date}T${time}` : null;

  const subjectId = "subject_1" as SubjectId;
  const subject: BookingSubject = {
    id: subjectId,
    role: "sender",
    label: "self",
    patient_name: patientName,
    service,
    slot,
    booking_contact: buildContact(phone, subjectId),
    status: "collecting",
    missing: [],
  };

  return {
    version: 3,
    status: "active",
    active_subject_id: subjectId,
    subjects: [subject],
    pending_typed_phone: null,
    max_subjects: 4,
  };
}

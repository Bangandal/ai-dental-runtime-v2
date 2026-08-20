import type { RuntimeAgentTurnInput } from "./openaiRuntimeAgent.ts";
import type { BookingContact, BookingSubject, BookingSubjectsState } from "./bookingSubjectsState.ts";

function phoneStatus(contact: BookingContact | null): "trusted" | "trusted_contact_owner" | "typed_unverified" | null {
  if (!contact) return null;
  if (contact.trust === "trusted") return "trusted";
  if (contact.trust === "trusted_contact_owner") return "trusted_contact_owner";
  return "typed_unverified";
}

function contactOwner(subject: BookingSubject, contact: BookingContact | null): "self" | string | null {
  if (!contact) return null;
  return contact.owner_subject_id === null || contact.owner_subject_id === subject.id
    ? "self"
    : contact.owner_subject_id;
}

function senderCanBeResponsibleParty(state: BookingSubjectsState): boolean {
  const sender = state.subjects.find((subject) => subject.id === "subject_1");
  const contact = sender?.booking_contact ?? null;
  if (!contact || contact.trust !== "trusted") return false;
  return contact.source !== "typed" && contact.source !== "shared_from_subject";
}

/**
 * Model-visible projection of booking subjects.
 *
 * The persisted target subject may intentionally have no own booking_contact when the sender
 * is booking for another person. In that case a trusted subject_1 contact is an effective
 * responsible-party booking contact, not proof of target patient identity. Expose that fact to
 * the model without copying phone numbers or pretending the contact is self-owned.
 *
 * A pending typed phone takes precedence over this derived fallback because ownership of that
 * newly supplied phone must be classified before the runtime assumes the sender contact is the
 * intended booking contact.
 */
function buildEffectiveBookingSubjectsContext(state: BookingSubjectsState): Record<string, unknown> {
  const responsiblePartyAvailable = state.pending_typed_phone == null && senderCanBeResponsibleParty(state);

  return {
    version: state.version,
    status: state.status,
    active_subject_id: state.active_subject_id,
    subjects: state.subjects.map((subject) => {
      const usesSenderResponsibleContact =
        responsiblePartyAvailable &&
        subject.id === state.active_subject_id &&
        subject.id !== "subject_1" &&
        subject.booking_contact == null;

      return {
        id: subject.id,
        label: subject.label,
        patient_name: subject.patient_name,
        service: subject.service,
        slot: subject.slot,
        phone_status: usesSenderResponsibleContact
          ? "trusted_contact_owner"
          : phoneStatus(subject.booking_contact),
        contact_owner: usesSenderResponsibleContact
          ? "subject_1"
          : contactOwner(subject, subject.booking_contact),
        missing: usesSenderResponsibleContact
          ? subject.missing.filter((item) => item !== "booking_contact")
          : subject.missing,
        status: subject.status,
      };
    }),
    ...(state.pending_typed_phone ? { pending_typed_phone: state.pending_typed_phone } : {}),
    max_subjects: state.max_subjects,
  };
}

export function buildModelVisibleCallerContext(input: RuntimeAgentTurnInput): Record<string, unknown> {
  const runtimeContext = (input.business_context?.runtime_context as Record<string, unknown> | undefined) ?? null;
  const runtimePolicy = runtimeContext && typeof runtimeContext.runtime_policy === "object"
    ? (runtimeContext.runtime_policy as Record<string, unknown>)
    : null;

  const effectiveRuntimeContext: Record<string, unknown> | null = runtimeContext
    ? { ...runtimeContext }
    : input.booking_subjects
      ? {}
      : null;

  if (effectiveRuntimeContext && input.booking_subjects) {
    effectiveRuntimeContext.booking_subjects = buildEffectiveBookingSubjectsContext(input.booking_subjects);
  }

  return {
    locale: input.locale ?? null,
    channel_context: {
      channel: input.business_context?.channel ?? null,
      patient_reachable_in_current_channel: Boolean(runtimePolicy?.patient_reachable_in_current_channel),
    },
    runtime_context: effectiveRuntimeContext,
    truth_snapshot: input.truth_snapshot ?? null,
    recent_summary: input.recent_summary ?? null,
  };
}

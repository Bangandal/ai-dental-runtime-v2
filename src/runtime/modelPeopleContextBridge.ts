import type {
  BookingContact,
  BookingSubject,
  BookingSubjectsState,
} from "./bookingSubjectsState.ts";

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
 * Current model-visible projection of the persisted people/booking registry.
 *
 * This module is the quarantine seam for the remaining legacy subject_N representation.
 * R2d intentionally preserves the current payload byte-for-byte at the semantic level;
 * a later R3 migration can replace IDs with self/active/other-person labels here without
 * changing OpenAI transport or persisted booking state at the same time.
 */
export function buildModelVisiblePeopleContext(
  state: BookingSubjectsState,
): Record<string, unknown> {
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

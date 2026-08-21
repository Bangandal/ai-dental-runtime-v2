import type { ChannelContact, ProvidedPhone } from "./openaiRuntimeAgent.ts";
import type {
  BookingContact,
  BookingSubjectsState,
  SubjectId,
} from "./bookingSubjectsState.ts";
import {
  hasBookingExecutionContact,
  resolveBookingExecutionContact,
  type BookingContactFact,
  type BookingDraft,
  type BookingDraftId,
  type BookingExecutionContact,
  type BookingPeopleState,
  type BookingPerson,
  type PersonId,
} from "./bookingPeople.ts";

/**
 * Temporary anti-corruption layer for the legacy Subject Registry.
 *
 * All `subject_*`, `shared_from_subject`, and sender fallback semantics must stop here.
 * New booking/identity code consumes BookingPeopleState and explicit phone ownership only.
 */
export interface LegacyBookingExecutionContactInput {
  booking_subjects: BookingSubjectsState | null;
  target_subject_id: SubjectId | null;
  channel_contact?: ChannelContact | null;
  provided_phone?: ProvidedPhone | null;
  had_booking_subjects?: boolean;
  current_turn_typed_phone?: string | null;
}

export function legacySubjectToPersonId(subjectId: SubjectId): PersonId {
  const suffix = subjectId.match(/^subject_(\d+)$/)?.[1];
  const n = suffix ? Number.parseInt(suffix, 10) : 0;
  return `person_${Number.isFinite(n) && n > 0 ? n : 1}` as PersonId;
}

export function legacySubjectToBookingId(subjectId: SubjectId): BookingDraftId {
  const suffix = subjectId.match(/^subject_(\d+)$/)?.[1];
  const n = suffix ? Number.parseInt(suffix, 10) : 0;
  return `booking_${Number.isFinite(n) && n > 0 ? n : 1}` as BookingDraftId;
}

function normalizeTrust(value: unknown): BookingContactFact["trust"] {
  if (value === "trusted" || value === "trusted_contact_owner") return "trusted";
  if (value === "unverified") return "unverified";
  return "unknown";
}

function resolveLegacyContact(
  contact: BookingContact | null,
  ownerSubjectFallback: SubjectId,
  state: BookingSubjectsState,
): BookingContactFact | null {
  if (!contact?.phone_number) return null;

  if (contact.source === "shared_from_subject") {
    const ownerSubjectId = contact.owner_subject_id;
    if (!ownerSubjectId) return null;
    const owner = state.subjects.find((subject) => subject.id === ownerSubjectId);
    const ownerContact = owner?.booking_contact ?? null;
    if (!ownerContact?.phone_number) return null;
    return {
      phone_number: ownerContact.phone_number,
      owner_person_id: legacySubjectToPersonId(ownerSubjectId),
      source: ownerContact.source,
      trust: normalizeTrust(ownerContact.trust),
    };
  }

  const ownerSubjectId = contact.owner_subject_id ?? ownerSubjectFallback;
  return {
    phone_number: contact.phone_number,
    owner_person_id: legacySubjectToPersonId(ownerSubjectId),
    source: contact.source,
    trust: normalizeTrust(contact.trust),
  };
}

function trustedSenderFallback(
  state: BookingSubjectsState,
  channelContact?: ChannelContact | null,
): BookingContactFact | null {
  const sender = state.subjects.find((subject) => subject.id === "subject_1");
  const senderContact = sender?.booking_contact ?? null;
  if (senderContact?.phone_number && senderContact.trust === "trusted") {
    return resolveLegacyContact(senderContact, "subject_1", state);
  }

  if (channelContact?.phone_number) {
    return {
      phone_number: channelContact.phone_number,
      owner_person_id: legacySubjectToPersonId("subject_1"),
      source: channelContact.phone_source ?? null,
      trust: "trusted",
    };
  }

  return null;
}

/** Project persisted legacy state into the clean people + bookings model. */
export function projectLegacySubjectsToBookingPeople(
  state: BookingSubjectsState,
  channelContact?: ChannelContact | null,
): BookingPeopleState {
  const people: BookingPerson[] = state.subjects.map((subject) => ({
    id: legacySubjectToPersonId(subject.id),
    name: subject.patient_name,
  }));

  const bookings: BookingDraft[] = state.subjects.map((subject) => {
    const ownContact = resolveLegacyContact(subject.booking_contact, subject.id, state);
    const contact = ownContact ?? (
      subject.id !== "subject_1"
        ? trustedSenderFallback(state, channelContact)
        : null
    );

    return {
      id: legacySubjectToBookingId(subject.id),
      person_id: legacySubjectToPersonId(subject.id),
      service: subject.service,
      slot: subject.slot,
      status: subject.status === "booked"
        ? "booked"
        : subject.status === "ready_for_booking"
          ? "ready_for_booking"
          : "collecting",
      contact,
    };
  });

  return {
    people,
    bookings,
    active_booking_id: legacySubjectToBookingId(state.active_subject_id),
    channel_sender_person_id: state.subjects.some((subject) => subject.id === "subject_1")
      ? legacySubjectToPersonId("subject_1")
      : null,
  };
}

/**
 * Compatibility entry point for the current runtimeAgentLoop.
 * It translates legacy subject targeting into clean booking/contact ownership once.
 */
export function resolveLegacyBookingExecutionContact(
  input: LegacyBookingExecutionContactInput,
): BookingExecutionContact {
  if (input.booking_subjects) {
    if (!input.target_subject_id) {
      return {
        phone_number: undefined,
        phone_source: undefined,
        phone_trust: undefined,
        phone_belongs_to_patient: undefined,
      };
    }

    const projected = projectLegacySubjectsToBookingPeople(
      input.booking_subjects,
      input.channel_contact,
    );
    return resolveBookingExecutionContact(
      projected,
      legacySubjectToBookingId(input.target_subject_id),
    );
  }

  // Single-person legacy flow. Preserve stale typed-phone suppression until the
  // old subject/provided_phone protocol is deleted.
  const isCurrentTurnTypedPhone =
    input.current_turn_typed_phone != null &&
    input.provided_phone?.phone_source === "typed" &&
    input.provided_phone.phone_number === input.current_turn_typed_phone;
  const suppressTypedPhone =
    input.had_booking_subjects === true &&
    input.provided_phone?.phone_source === "typed" &&
    !isCurrentTurnTypedPhone;
  const effectiveProvided = suppressTypedPhone ? null : (input.provided_phone ?? null);
  const phoneNumber = effectiveProvided?.phone_number ?? input.channel_contact?.phone_number;

  return {
    phone_number: phoneNumber,
    phone_source: effectiveProvided?.phone_source ?? input.channel_contact?.phone_source,
    phone_trust: effectiveProvided?.phone_trust,
    phone_belongs_to_patient: phoneNumber ? true : undefined,
  };
}

export function hasLegacyBookingExecutionContact(
  input: LegacyBookingExecutionContactInput,
): boolean {
  if (!input.booking_subjects) {
    return resolveLegacyBookingExecutionContact(input).phone_number != null;
  }

  if (!input.target_subject_id) return false;
  const projected = projectLegacySubjectsToBookingPeople(
    input.booking_subjects,
    input.channel_contact,
  );
  return hasBookingExecutionContact(
    projected,
    legacySubjectToBookingId(input.target_subject_id),
  );
}

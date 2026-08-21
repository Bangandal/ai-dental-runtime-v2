/**
 * Small semantic booking model used by the clean Runtime core.
 *
 * A person is just a person. The kernel intentionally does not classify people as
 * self, mother, child, responsible party, sender, or any other social role.
 * Facts belong to people, bookings target people, and contact ownership is explicit.
 */
export type PersonId = `person_${number}`;
export type BookingDraftId = `booking_${number}`;

export interface BookingPerson {
  id: PersonId;
  name: string | null;
}

export interface BookingContactFact {
  phone_number: string;
  /** null means ownership is unknown, never implicitly the booked person. */
  owner_person_id: PersonId | null;
  source: string | null;
  trust: "trusted" | "unverified" | "unknown";
}

export interface BookingDraft {
  id: BookingDraftId;
  person_id: PersonId;
  service: string | null;
  slot: string | null;
  status: "collecting" | "ready_for_booking" | "booked";
  contact: BookingContactFact | null;
}

export interface BookingPeopleState {
  people: BookingPerson[];
  bookings: BookingDraft[];
  active_booking_id: BookingDraftId | null;
  /** Transport attribution only. It does not classify the person socially. */
  channel_sender_person_id: PersonId | null;
}

export interface BookingExecutionContact {
  phone_number: string | undefined;
  phone_source: string | undefined;
  phone_trust: "unverified" | undefined;
  /** True only when the contact fact is explicitly owned by the booked person. */
  phone_belongs_to_patient: boolean | undefined;
}

export function getBookingDraft(
  state: BookingPeopleState,
  bookingId: BookingDraftId,
): BookingDraft | null {
  return state.bookings.find((booking) => booking.id === bookingId) ?? null;
}

/**
 * Convert a booking's contact fact into the only identity signal downstream code needs.
 * No subject ids, family relations, or responsible-party labels cross this boundary.
 */
export function resolveBookingExecutionContact(
  state: BookingPeopleState,
  bookingId: BookingDraftId,
): BookingExecutionContact {
  const booking = getBookingDraft(state, bookingId);
  const contact = booking?.contact ?? null;

  if (!booking || !contact) {
    return {
      phone_number: undefined,
      phone_source: undefined,
      phone_trust: undefined,
      phone_belongs_to_patient: undefined,
    };
  }

  return {
    phone_number: contact.phone_number,
    phone_source: contact.source ?? undefined,
    phone_trust: contact.trust === "unverified" ? "unverified" : undefined,
    phone_belongs_to_patient:
      contact.owner_person_id == null
        ? undefined
        : contact.owner_person_id === booking.person_id,
  };
}

export function hasBookingExecutionContact(
  state: BookingPeopleState,
  bookingId: BookingDraftId,
): boolean {
  return resolveBookingExecutionContact(state, bookingId).phone_number != null;
}

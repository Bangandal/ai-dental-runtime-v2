import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveBookingExecutionContact,
  type BookingPeopleState,
} from "../src/runtime/bookingPeople.ts";
import {
  projectLegacySubjectsToBookingPeople,
  resolveLegacyBookingExecutionContact,
} from "../src/runtime/legacyBookingSubjectsAdapter.ts";
import type {
  BookingContact,
  BookingSubject,
  BookingSubjectsState,
} from "../src/runtime/bookingSubjectsState.ts";

function contact(overrides: Partial<BookingContact> = {}): BookingContact {
  return {
    phone_number: "+420111222333",
    source: "telegram_contact_button",
    trust: "trusted",
    owner_subject_id: null,
    collected_at: "2026-08-21T03:00:00Z",
    ...overrides,
  };
}

function subject(
  id: BookingSubject["id"],
  overrides: Partial<BookingSubject> = {},
): BookingSubject {
  return {
    id,
    role: id === "subject_1" ? "sender" : "mentioned_person",
    label: null,
    patient_name: null,
    service: null,
    slot: null,
    booking_contact: null,
    status: "collecting",
    missing: [],
    ...overrides,
  };
}

function state(subjects: BookingSubject[]): BookingSubjectsState {
  return {
    version: 3,
    status: "active",
    active_subject_id: subjects[0]?.id ?? "subject_1",
    subjects,
    pending_typed_phone: null,
    max_subjects: 4,
  };
}

test("R1B-CORE-1: clean booking core resolves ownership without any subject vocabulary", () => {
  const clean: BookingPeopleState = {
    people: [
      { id: "person_1", name: "Anna Koval" },
      { id: "person_2", name: "Marta Koval" },
    ],
    bookings: [
      {
        id: "booking_2",
        person_id: "person_2",
        service: "orthodontics",
        slot: null,
        status: "collecting",
        contact: {
          phone_number: "+420111222333",
          owner_person_id: "person_1",
          source: "telegram_contact_button",
          trust: "trusted",
        },
      },
    ],
    active_booking_id: "booking_2",
    channel_sender_person_id: "person_1",
  };

  const resolved = resolveBookingExecutionContact(clean, "booking_2");

  assert.equal(resolved.phone_number, "+420111222333");
  assert.equal(resolved.phone_belongs_to_patient, false);
  assert.equal(JSON.stringify(clean).includes("subject_"), false);
  assert.equal(JSON.stringify(clean).includes("responsible_party"), false);
});

test("R1B-PEOPLE-1: legacy registry projects to plain people + booking drafts", () => {
  const legacy = state([
    subject("subject_1", { patient_name: "Anna Koval", service: "cleaning" }),
    subject("subject_2", { patient_name: "Marta Koval", service: "orthodontics" }),
  ]);

  const projected = projectLegacySubjectsToBookingPeople(legacy);

  assert.deepEqual(projected.people, [
    { id: "person_1", name: "Anna Koval" },
    { id: "person_2", name: "Marta Koval" },
  ]);
  assert.equal(projected.bookings[0]?.person_id, "person_1");
  assert.equal(projected.bookings[1]?.person_id, "person_2");
  assert.equal(projected.bookings[0]?.service, "cleaning");
  assert.equal(projected.bookings[1]?.service, "orthodontics");
  assert.equal("role" in projected.people[0]!, false);
  assert.equal("relation" in projected.people[0]!, false);
});

test("R1B-PEOPLE-2: shared sender phone remains owned by another person", () => {
  const legacy = state([
    subject("subject_1", { booking_contact: contact() }),
    subject("subject_2", {
      patient_name: "Marta Koval",
      booking_contact: contact({
        source: "shared_from_subject",
        trust: "trusted_contact_owner",
        owner_subject_id: "subject_1",
      }),
    }),
  ]);

  const resolved = resolveLegacyBookingExecutionContact({
    booking_subjects: legacy,
    target_subject_id: "subject_2",
  });

  assert.equal(resolved.phone_number, "+420111222333");
  assert.equal(resolved.phone_source, "telegram_contact_button");
  assert.equal(resolved.phone_belongs_to_patient, false);
});

test("R1B-PEOPLE-3: target person's own typed phone belongs to the target", () => {
  const legacy = state([
    subject("subject_1", { booking_contact: contact() }),
    subject("subject_2", {
      booking_contact: contact({
        phone_number: "+420999888777",
        source: "typed",
        trust: "unverified",
        owner_subject_id: "subject_2",
      }),
    }),
  ]);

  const resolved = resolveLegacyBookingExecutionContact({
    booking_subjects: legacy,
    target_subject_id: "subject_2",
  });

  assert.equal(resolved.phone_number, "+420999888777");
  assert.equal(resolved.phone_trust, "unverified");
  assert.equal(resolved.phone_belongs_to_patient, true);
});

test("R1B-PEOPLE-4: channel sender contact used for another target is not target identity", () => {
  const legacy = state([
    subject("subject_1"),
    subject("subject_2", { patient_name: "Marta Koval" }),
  ]);

  const resolved = resolveLegacyBookingExecutionContact({
    booking_subjects: legacy,
    target_subject_id: "subject_2",
    channel_contact: {
      phone_number: "+420555444333",
      phone_source: "telegram_contact_button",
    },
  });

  assert.equal(resolved.phone_number, "+420555444333");
  assert.equal(resolved.phone_belongs_to_patient, false);
});

test("R1B-PEOPLE-5: single-person flow treats current booking contact as patient-owned", () => {
  const resolved = resolveLegacyBookingExecutionContact({
    booking_subjects: null,
    target_subject_id: null,
    provided_phone: {
      phone_number: "+420777666555",
      phone_source: "typed",
      phone_trust: "unverified",
      phone_consent: false,
      phone_collected_at: "2026-08-21T03:00:00Z",
    },
    current_turn_typed_phone: "+420777666555",
  });

  assert.equal(resolved.phone_number, "+420777666555");
  assert.equal(resolved.phone_belongs_to_patient, true);
});

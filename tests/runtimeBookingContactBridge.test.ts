import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeBookingContactFields,
  hasRuntimeBookingContact,
} from "../src/runtime/runtimeBookingContactBridge.ts";
import type { RuntimeAgentTurnInput } from "../src/runtime/openaiRuntimeAgent.ts";
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
    collected_at: "2026-08-21T04:00:00Z",
    ...overrides,
  };
}

function subject(id: BookingSubject["id"], overrides: Partial<BookingSubject> = {}): BookingSubject {
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

function registry(subjects: BookingSubject[]): BookingSubjectsState {
  return {
    version: 3,
    status: "active",
    active_subject_id: subjects[0]?.id ?? "subject_1",
    subjects,
    pending_typed_phone: null,
    max_subjects: 4,
  };
}

function input(overrides: Partial<RuntimeAgentTurnInput> = {}): RuntimeAgentTurnInput {
  return {
    trace_id: "trace-r1-contact",
    clinic_id: "clinic_1",
    user_message: "book",
    ...overrides,
  } as RuntimeAgentTurnInput;
}

test("R1-CONTACT-1: shared sender contact reaches booking execution as non-patient-owned", () => {
  const booking_subjects = registry([
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

  const fields = buildRuntimeBookingContactFields(input({ booking_subjects }), "subject_2");

  assert.equal(fields.phone_number, "+420111222333");
  assert.equal(fields.phone_source, "telegram_contact_button");
  assert.equal(fields.phone_belongs_to_patient, false);
  assert.equal(hasRuntimeBookingContact(input({ booking_subjects }), "subject_2"), true);
});

test("R1-CONTACT-2: channel sender fallback for another patient is contactability, never identity", () => {
  const booking_subjects = registry([
    subject("subject_1"),
    subject("subject_2", { patient_name: "Marta Koval" }),
  ]);

  const fields = buildRuntimeBookingContactFields(input({
    booking_subjects,
    channel_contact: {
      phone_number: "+420555444333",
      phone_source: "telegram_contact_button",
    },
  }), "subject_2");

  assert.equal(fields.phone_number, "+420555444333");
  assert.equal(fields.phone_belongs_to_patient, false);
});

test("R1-CONTACT-3: target-owned typed phone remains identity-eligible but unverified", () => {
  const booking_subjects = registry([
    subject("subject_1", { booking_contact: contact() }),
    subject("subject_2", {
      patient_name: "Marta Koval",
      booking_contact: contact({
        phone_number: "+420999888777",
        source: "typed",
        trust: "unverified",
        owner_subject_id: "subject_2",
      }),
    }),
  ]);

  const fields = buildRuntimeBookingContactFields(input({ booking_subjects }), "subject_2");

  assert.equal(fields.phone_number, "+420999888777");
  assert.equal(fields.phone_trust, "unverified");
  assert.equal(fields.phone_belongs_to_patient, true);
});

test("R1-CONTACT-4: active registry without explicit execution target cannot borrow a phone", () => {
  const booking_subjects = registry([
    subject("subject_1", { booking_contact: contact() }),
    subject("subject_2", { patient_name: "Marta Koval" }),
  ]);

  const fields = buildRuntimeBookingContactFields(input({ booking_subjects }), null);

  assert.equal(fields.phone_number, undefined);
  assert.equal(fields.phone_belongs_to_patient, undefined);
  assert.equal(hasRuntimeBookingContact(input({ booking_subjects }), null), false);
});

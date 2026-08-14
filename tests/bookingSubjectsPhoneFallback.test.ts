/**
 * Tests for subject-1-as-responsible-party phone fallback in buildSubjectAwarePhoneFields
 * and hasSubjectOrContactPhone. Covers the common case where the sender books for another
 * person (subject_2) and their own trusted phone serves as the booking contact.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildSubjectAwarePhoneFields, hasSubjectOrContactPhone } from "../src/runtime/runtimeAgentLoop.ts";
import type { RuntimeAgentTurnInput } from "../src/runtime/openaiRuntimeAgent.ts";
import type { BookingSubjectsState } from "../src/runtime/bookingSubjectsState.ts";

function makeInput(
  subjects: BookingSubjectsState["subjects"],
  channelContact?: RuntimeAgentTurnInput["channel_contact"],
): RuntimeAgentTurnInput {
  return {
    clinic_id: "clinic_1",
    user_message: "test",
    booking_subjects: {
      active_subject_id: "subject_2",
      subjects,
    } as BookingSubjectsState,
    channel_contact: channelContact,
  };
}

const trustedS1Contact = {
  id: "subject_1" as const,
  booking_contact: {
    phone_number: "111222333",
    source: "telegram_contact_button",
    trust: "trusted",
    owner_subject_id: null,
    collected_at: "2026-08-14T12:00:00Z",
  },
  status: "active" as const,
  missing: {},
  display_name: null,
  labels: [],
};

const untrustedS1Contact = {
  id: "subject_1" as const,
  booking_contact: {
    phone_number: "333444555",
    source: "typed",
    trust: "unverified",
    owner_subject_id: null,
    collected_at: "2026-08-14T12:00:00Z",
  },
  status: "active" as const,
  missing: {},
  display_name: null,
  labels: [],
};

const s2NoPhone = {
  id: "subject_2" as const,
  booking_contact: null,
  status: "active" as const,
  missing: {},
  display_name: "Друг",
  labels: [],
};

// PHONE-SUBJ-1: subject_2 has no phone, subject_1 has trusted phone → use subject_1's
test("PHONE-SUBJ-1: hasSubjectOrContactPhone — falls back to trusted subject_1 phone", () => {
  const input = makeInput([trustedS1Contact, s2NoPhone]);
  assert.strictEqual(hasSubjectOrContactPhone(input, "subject_2"), true);
});

test("PHONE-SUBJ-1: buildSubjectAwarePhoneFields — returns subject_1 phone as fallback", () => {
  const input = makeInput([trustedS1Contact, s2NoPhone]);
  const fields = buildSubjectAwarePhoneFields(input, "subject_2");
  assert.strictEqual(fields.phone_number, "111222333");
  assert.strictEqual(fields.phone_source, "telegram_contact_button");
});

// PHONE-SUBJ-2: subject_2 no phone, subject_1 no phone, global channel_contact set
test("PHONE-SUBJ-2: hasSubjectOrContactPhone — falls back to global channel_contact", () => {
  const s1NoPhone = { ...trustedS1Contact, booking_contact: null };
  const input = makeInput([s1NoPhone, s2NoPhone], {
    phone_number: "222333444",
    phone_source: "telegram_contact_button",
  });
  assert.strictEqual(hasSubjectOrContactPhone(input, "subject_2"), true);
});

test("PHONE-SUBJ-2: buildSubjectAwarePhoneFields — returns channel_contact as fallback", () => {
  const s1NoPhone = { ...trustedS1Contact, booking_contact: null };
  const input = makeInput([s1NoPhone, s2NoPhone], {
    phone_number: "222333444",
    phone_source: "telegram_contact_button",
  });
  const fields = buildSubjectAwarePhoneFields(input, "subject_2");
  assert.strictEqual(fields.phone_number, "222333444");
  assert.strictEqual(fields.phone_source, "telegram_contact_button");
});

// PHONE-SUBJ-3: subject_2 no phone, subject_1 has TYPED (unverified) phone → no fallback
test("PHONE-SUBJ-3: hasSubjectOrContactPhone — typed subject_1 phone does NOT qualify as fallback", () => {
  const input = makeInput([untrustedS1Contact, s2NoPhone]);
  assert.strictEqual(hasSubjectOrContactPhone(input, "subject_2"), false);
});

test("PHONE-SUBJ-3: buildSubjectAwarePhoneFields — typed subject_1 phone not used as fallback", () => {
  const input = makeInput([untrustedS1Contact, s2NoPhone]);
  const fields = buildSubjectAwarePhoneFields(input, "subject_2");
  assert.strictEqual(fields.phone_number, undefined);
});

// PHONE-SUBJ-4: subject_1 is execution target with no phone → no fallback (self-booking)
test("PHONE-SUBJ-4: hasSubjectOrContactPhone — no fallback when subject_1 has no phone", () => {
  const s1NoPhone = { ...trustedS1Contact, booking_contact: null };
  const input = makeInput([s1NoPhone, s2NoPhone]);
  assert.strictEqual(hasSubjectOrContactPhone(input, "subject_1"), false);
});

test("PHONE-SUBJ-4: buildSubjectAwarePhoneFields — no fallback for subject_1 targeting self", () => {
  const s1NoPhone = { ...trustedS1Contact, booking_contact: null };
  const input = makeInput([s1NoPhone, s2NoPhone]);
  const fields = buildSubjectAwarePhoneFields(input, "subject_1");
  assert.strictEqual(fields.phone_number, undefined);
});

// Regression: subject_2 has its own trusted phone → use it directly (no fallback needed)
test("REGRESSION: subject_2 with own trusted phone uses it directly", () => {
  const s2WithPhone = {
    ...s2NoPhone,
    booking_contact: {
      phone_number: "999888777",
      source: "telegram_contact_button",
      trust: "trusted",
      owner_subject_id: null,
      collected_at: "2026-08-14T12:00:00Z",
    },
  };
  const input = makeInput([trustedS1Contact, s2WithPhone]);
  assert.strictEqual(hasSubjectOrContactPhone(input, "subject_2"), true);
  const fields = buildSubjectAwarePhoneFields(input, "subject_2");
  assert.strictEqual(fields.phone_number, "999888777");
});

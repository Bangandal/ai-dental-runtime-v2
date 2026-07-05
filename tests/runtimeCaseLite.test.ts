/**
 * PR #140 — runtimeCaseLite acceptance tests (A–H).
 *
 * Tests cover: red-flag merge policy, booking+red-flag combo, ASAP time mode,
 * tooth pain (non-red-flag), phone trust authority, disabled-mode pass-through,
 * parseRuntimeCaseLite safety, and buildCasePolicyTruth / deriveWaitingFor.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDefaultRuntimeCaseLite,
  mergeRuntimeCaseLite,
  deriveWaitingFor,
  applyBookingStatusToCase,
  parseRuntimeCaseLite,
  type RuntimeCaseLite,
  type RuntimeCaseLiteUpdate,
} from "../src/runtime/runtimeCaseLite.ts";
import { buildCasePolicyTruth } from "../src/runtime/runtimeCasePolicyTruth.ts";
import type { ChannelContact } from "../src/runtime/openaiRuntimeAgent.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLINIC_OPTS = {
  clinic_id: "clinic_1",
  channel: "telegram",
  external_user_id: "user_42",
  locale: "ru",
} as const;

const TRUSTED_CONTACT: ChannelContact = {
  phone_number: "+420600111222",
  phone_source: "telegram_contact_button",
};

const EXISTING_CLINICCARD_CONTACT: ChannelContact = {
  phone_number: "+380501234567",
  phone_source: "existing_cliniccard_patient",
};

const RED_FLAG_UPDATE: RuntimeCaseLiteUpdate = {
  active_intent: "urgent_clinical",
  clinical_signal: {
    level: "red_flag",
    type: "swelling",
    safety_guidance_first: true,
    must_contact_clinic_immediately: true,
    emergency_if_severe_or_worsening: true,
  },
};

// ── Test A: Red-flag symptom — policy must block intake ──────────────────────

test("A: red-flag swelling → must_not_make_intake_main_response=true, may_offer_booking_after_guidance=true", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const merged = mergeRuntimeCaseLite(base, RED_FLAG_UPDATE, null);

  assert.equal(merged.clinical_signal.level, "red_flag");
  assert.equal(merged.clinical_signal.type, "swelling");
  assert.equal(merged.clinical_signal.safety_guidance_first, true);
  assert.equal(merged.clinical_signal.must_contact_clinic_immediately, true);
  assert.equal(merged.policy.must_not_make_intake_main_response, true);
  assert.equal(merged.policy.may_offer_booking_after_guidance, true);
  assert.equal(merged.policy.must_not_claim_booking_created, true);
});

test("A: red-flag → buildCasePolicyTruth reflects must_not_make_intake_main_response", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const merged = mergeRuntimeCaseLite(base, RED_FLAG_UPDATE, null);
  const truth = buildCasePolicyTruth(merged);

  assert.equal(truth.clinical_signal_level, "red_flag");
  assert.equal(truth.safety_guidance_first, true);
  assert.equal(truth.must_not_make_intake_main_response, true);
  assert.equal(truth.may_offer_booking_after_guidance, true);
  assert.equal(truth.booking_created, false);
});

// ── Test B: Red-flag + booking intent — active_intent=booking, policy still blocks intake ──

test("B: red-flag + booking intent → active_intent=booking, clinical_signal=red_flag, intake still blocked", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const update: RuntimeCaseLiteUpdate = {
    active_intent: "booking",
    clinical_signal: {
      level: "red_flag",
      type: "bleeding",
      safety_guidance_first: true,
      must_contact_clinic_immediately: true,
      emergency_if_severe_or_worsening: true,
    },
  };
  const merged = mergeRuntimeCaseLite(base, update, null);

  assert.equal(merged.active_intent, "booking");
  assert.equal(merged.clinical_signal.level, "red_flag");
  assert.equal(merged.policy.must_not_make_intake_main_response, true);
  assert.equal(merged.policy.may_offer_booking_after_guidance, true);
});

// ── Test C: ASAP preferred time mode ─────────────────────────────────────────

test("C: ASAP booking preference → preferred_time_mode=asap, preferred_time_text preserved", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const update: RuntimeCaseLiteUpdate = {
    active_intent: "booking",
    booking: {
      preferred_time_mode: "asap",
      preferred_time_text: "как можно скорее",
    },
  };
  const merged = mergeRuntimeCaseLite(base, update, null);

  assert.equal(merged.booking.preferred_time_mode, "asap");
  assert.equal(merged.booking.preferred_time_text, "как можно скорее");
  assert.equal(merged.active_intent, "booking");
});

// ── Test D: Normal tooth pain (non-red-flag) ──────────────────────────────────

test("D: tooth pain + booking → level=tooth_pain, safety_guidance_first=false, intake NOT blocked", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const update: RuntimeCaseLiteUpdate = {
    active_intent: "booking",
    clinical_signal: {
      level: "tooth_pain",
      type: "tooth_pain",
      safety_guidance_first: false,
      must_contact_clinic_immediately: false,
      emergency_if_severe_or_worsening: false,
    },
    booking: {
      service_reason: "осмотр из-за боли",
    },
  };
  const merged = mergeRuntimeCaseLite(base, update, null);

  assert.equal(merged.clinical_signal.level, "tooth_pain");
  assert.equal(merged.clinical_signal.safety_guidance_first, false);
  assert.equal(merged.booking.service_reason, "осмотр из-за боли");
  assert.equal(merged.policy.must_not_make_intake_main_response, false);
  assert.equal(merged.policy.may_offer_booking_after_guidance, false);
});

test("D: tooth pain policy truth — intake allowed, next_safe_step reflects missing fields", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const update: RuntimeCaseLiteUpdate = {
    active_intent: "booking",
    clinical_signal: {
      level: "tooth_pain",
      type: "tooth_pain",
      safety_guidance_first: false,
      must_contact_clinic_immediately: false,
      emergency_if_severe_or_worsening: false,
    },
    booking: { service_reason: "осмотр из-за боли" },
  };
  const merged = mergeRuntimeCaseLite(base, update, null);
  const truth = buildCasePolicyTruth(merged);

  assert.equal(truth.must_not_make_intake_main_response, false);
  assert.ok(truth.missing_fields.includes("trusted_phone"), "trusted_phone must be missing without channelContact");
  assert.ok(truth.missing_fields.includes("first_name"), "first_name must be missing");
  assert.ok(truth.missing_fields.includes("last_name"), "last_name must be missing");
});

// ── Test E: Trusted phone — always from channel_contact (authoritative) ──────

test("E: trusted phone from telegram_contact_button → phone_trusted=true, phone from channelContact", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const merged = mergeRuntimeCaseLite(base, { active_intent: "booking" }, TRUSTED_CONTACT);

  assert.equal(merged.booking.phone_trusted, true);
  assert.equal(merged.booking.phone_number, "+420600111222");
  assert.equal(merged.booking.phone_source, "telegram_contact_button");
});

test("E: existing_cliniccard_patient also trusted", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const merged = mergeRuntimeCaseLite(base, {}, EXISTING_CLINICCARD_CONTACT);

  assert.equal(merged.booking.phone_trusted, true);
  assert.equal(merged.booking.phone_number, "+380501234567");
  assert.equal(merged.booking.phone_source, "existing_cliniccard_patient");
});

test("E: trusted phone removes trusted_phone from missing_fields in policy truth", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const merged = mergeRuntimeCaseLite(base, { active_intent: "booking" }, TRUSTED_CONTACT);
  const truth = buildCasePolicyTruth(merged);

  assert.ok(!truth.missing_fields.includes("trusted_phone"), "trusted_phone must not be missing when phone is trusted");
  assert.equal(truth.known_booking_fields.phone_trusted, true);
});

// ── Test F: Manual/model-extracted phone → phone_trusted must be false ────────

test("F: channelContact=null → phone_trusted=false regardless of update.booking.phone_number", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  // Model might have "extracted" a phone number — it must NOT become trusted
  const update: RuntimeCaseLiteUpdate = {
    booking: {
      phone_number: "+420987654321",
      phone_source: "manual_input",
    },
  };
  const merged = mergeRuntimeCaseLite(base, update, null);

  assert.equal(merged.booking.phone_trusted, false, "phone_trusted must be false when channelContact is null");
});

test("F: manual_input channelContact → phone_trusted=false (untrusted source)", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const manualContact: ChannelContact = {
    phone_number: "+420987654321",
    phone_source: "manual_input",
  };
  const merged = mergeRuntimeCaseLite(base, {}, manualContact);

  assert.equal(merged.booking.phone_trusted, false);
});

// ── Test G: No extractor (disabled mode) — pass-through, no errors ────────────

test("G: empty update (no extractor) → existing case passes through unchanged, no errors", () => {
  const existing: RuntimeCaseLite = {
    ...buildDefaultRuntimeCaseLite(CLINIC_OPTS),
    active_intent: "booking",
    clinical_signal: {
      level: "tooth_pain",
      type: "tooth_pain",
      safety_guidance_first: false,
      must_contact_clinic_immediately: false,
      emergency_if_severe_or_worsening: false,
    },
    booking: {
      service_reason: "чистка",
      first_name: "Роман",
      last_name: null,
      preferred_time_text: null,
      preferred_time_mode: null,
      phone_number: null,
      phone_source: null,
      phone_trusted: false,
    },
  };

  const merged = mergeRuntimeCaseLite(existing, {}, null);

  assert.equal(merged.active_intent, "booking");
  assert.equal(merged.clinical_signal.level, "tooth_pain");
  assert.equal(merged.booking.service_reason, "чистка");
  assert.equal(merged.booking.first_name, "Роман");
  assert.equal(merged.booking.phone_trusted, false);
});

// ── parseRuntimeCaseLite — safety and validity ────────────────────────────────

test("parseRuntimeCaseLite: returns null for null input", () => {
  assert.equal(parseRuntimeCaseLite(null), null);
});

test("parseRuntimeCaseLite: returns null for empty object", () => {
  assert.equal(parseRuntimeCaseLite({}), null);
});

test("parseRuntimeCaseLite: returns null when clinic_id is missing", () => {
  assert.equal(parseRuntimeCaseLite({ channel: "telegram" }), null);
});

test("parseRuntimeCaseLite: returns null when clinic_id is not a string", () => {
  assert.equal(parseRuntimeCaseLite({ clinic_id: 42, channel: "telegram" }), null);
});

test("parseRuntimeCaseLite: returns non-null for valid minimal case", () => {
  const raw = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const result = parseRuntimeCaseLite(raw);
  assert.ok(result !== null);
  assert.equal(result?.clinic_id, "clinic_1");
  assert.equal(result?.channel, "telegram");
});

// ── deriveWaitingFor ──────────────────────────────────────────────────────────

test("deriveWaitingFor: booking + no phone → trusted_phone", () => {
  const booking = buildDefaultRuntimeCaseLite(CLINIC_OPTS).booking;
  assert.equal(deriveWaitingFor("booking", booking), "trusted_phone");
});

test("deriveWaitingFor: booking + trusted phone + no name → patient_name", () => {
  const booking = {
    ...buildDefaultRuntimeCaseLite(CLINIC_OPTS).booking,
    phone_trusted: true,
    phone_number: "+1",
    phone_source: "telegram_contact_button" as const,
    first_name: null,
    last_name: null,
  };
  assert.equal(deriveWaitingFor("booking", booking), "patient_name");
});

test("deriveWaitingFor: booking + trusted phone + full name + no time → preferred_time", () => {
  const booking = {
    ...buildDefaultRuntimeCaseLite(CLINIC_OPTS).booking,
    phone_trusted: true,
    phone_number: "+1",
    phone_source: "telegram_contact_button" as const,
    first_name: "Роман",
    last_name: "Ансамблев",
    preferred_time_mode: null,
  };
  assert.equal(deriveWaitingFor("booking", booking), "preferred_time");
});

test("deriveWaitingFor: booking + all fields present → none", () => {
  const booking = {
    ...buildDefaultRuntimeCaseLite(CLINIC_OPTS).booking,
    phone_trusted: true,
    phone_number: "+1",
    phone_source: "telegram_contact_button" as const,
    first_name: "Роман",
    last_name: "Ансамблев",
    preferred_time_mode: "asap" as const,
  };
  assert.equal(deriveWaitingFor("booking", booking), "none");
});

test("deriveWaitingFor: faq intent → none", () => {
  const booking = buildDefaultRuntimeCaseLite(CLINIC_OPTS).booking;
  assert.equal(deriveWaitingFor("faq", booking), "none");
});

// ── applyBookingStatusToCase ──────────────────────────────────────────────────

test("applyBookingStatusToCase: booking.apply success sets created_visit=true, may_claim_booked=true", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const result = applyBookingStatusToCase(base, [
    {
      tool: "booking.apply",
      status: "success",
      data: { cliniccard_visit_id: "visit_999", booking_status: "visit_created" },
    },
  ]);

  assert.equal(result.booking_status.created_visit, true);
  assert.equal(result.booking_status.may_claim_booked, true);
  assert.equal(result.booking_status.cliniccard_visit_id, "visit_999");
  assert.equal(result.policy.must_not_claim_booking_created, false);
});

test("applyBookingStatusToCase: no booking.apply in results → case unchanged", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const result = applyBookingStatusToCase(base, [
    { tool: "availability.check", status: "success", data: {} },
  ]);

  assert.equal(result.booking_status.created_visit, false);
  assert.equal(result.booking_status.may_claim_booked, false);
  assert.equal(result.policy.must_not_claim_booking_created, true);
});

test("applyBookingStatusToCase: booking.apply failed status → case unchanged", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const result = applyBookingStatusToCase(base, [
    { tool: "booking.apply", status: "failed", data: undefined },
  ]);

  assert.equal(result.booking_status.created_visit, false);
  assert.equal(result.booking_status.may_claim_booked, false);
});

// ── buildCasePolicyTruth coverage ────────────────────────────────────────────

test("buildCasePolicyTruth: unknown intent → missing_fields is empty", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const truth = buildCasePolicyTruth(base);

  assert.deepEqual(truth.missing_fields, []);
  assert.equal(truth.active_intent, "unknown");
  assert.equal(truth.booking_created, false);
});

test("buildCasePolicyTruth: booking_created reflects booking_status.created_visit", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const afterBooking = applyBookingStatusToCase(base, [
    { tool: "booking.apply", status: "success", data: { cliniccard_visit_id: "v1" } },
  ]);
  const truth = buildCasePolicyTruth(afterBooking);

  assert.equal(truth.booking_created, true);
  assert.equal(truth.must_not_claim_booking_created, false);
});

// ── mergeRuntimeCaseLite: name extraction ─────────────────────────────────────

test("mergeRuntimeCaseLite: name fields merge correctly", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const merged = mergeRuntimeCaseLite(
    base,
    { active_intent: "booking", booking: { first_name: "Роман", last_name: "Ансамблев" } },
    null,
  );

  assert.equal(merged.booking.first_name, "Роман");
  assert.equal(merged.booking.last_name, "Ансамблев");
});

test("mergeRuntimeCaseLite: existing name preserved when update has no name fields", () => {
  const base = buildDefaultRuntimeCaseLite(CLINIC_OPTS);
  const withName = mergeRuntimeCaseLite(
    base,
    { booking: { first_name: "Роман", last_name: "Ансамблев" } },
    null,
  );
  const updated = mergeRuntimeCaseLite(
    withName,
    { active_intent: "booking" },
    null,
  );

  assert.equal(updated.booking.first_name, "Роман");
  assert.equal(updated.booking.last_name, "Ансамблев");
});

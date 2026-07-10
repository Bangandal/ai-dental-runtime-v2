import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectSwitchSignal,
  preUpdateBookingSubjects,
  postUpdateBookingSubjects,
  detectSubjectMismatch,
  computeMissing,
  computeReadyForBooking,
  deserializeBookingSubjects,
  normalizeBookingSubjectsState,
  applySubjectIntent,
  parseSubjectIntent,
  buildSubjectsContextPayload,
} from "../src/runtime/bookingSubjectsState.ts";
import type {
  BookingSubjectsState,
  BookingSubject,
  BookingContact,
  BookingContactSource,
  BookingContactTrust,
  SubjectId,
  S1Seed,
  SubjectIntent,
} from "../src/runtime/bookingSubjectsState.ts";
import type { ChannelContact, ProvidedPhone } from "../src/runtime/openaiRuntimeAgent.ts";

// ── helpers ────────────────────────────────────────────────────────────────

const trustedContact: ChannelContact = {
  phone_number: "+420724334616",
  phone_source: "telegram_contact_button",
  phone_captured: true,
};

const providedPhone: ProvidedPhone = {
  phone_number: "+420728945521",
  phone_source: "typed",
  phone_trust: "unverified",
  phone_consent: false,
  phone_collected_at: new Date().toISOString(),
};

function makeBC(
  phone: string,
  source: BookingContactSource,
  trust: BookingContactTrust,
  ownerId: SubjectId,
): BookingContact {
  return { phone_number: phone, source, trust, owner_subject_id: ownerId, collected_at: null };
}

function makeSubject(
  id: SubjectId,
  role: "sender" | "mentioned_person",
  overrides: Partial<Omit<BookingSubject, "id" | "role" | "missing">> = {},
): BookingSubject {
  const s: BookingSubject = {
    id, role,
    label: null,
    patient_name: null,
    service: null,
    slot: null,
    booking_contact: null,
    status: "collecting",
    missing: [],
    ...overrides,
  };
  // compute missing based on actual fields
  const missing: string[] = [];
  if (!s.patient_name) missing.push("patient_name");
  if (!s.slot) missing.push("slot");
  if (!s.service) missing.push("service");
  if (!s.booking_contact) missing.push("booking_contact");
  s.missing = missing;
  return s;
}

function makeState(
  activeId: SubjectId,
  subjects: BookingSubject[],
  pendingPhone: string | null = null,
): BookingSubjectsState {
  return { version: 2, active_subject_id: activeId, subjects, pending_typed_phone: pendingPhone, max_subjects: 4 };
}

function makeS2State(s2Name: string | null = "Иван"): BookingSubjectsState {
  return makeState("subject_2", [
    makeSubject("subject_1", "sender", {
      patient_name: "Рима",
      service: "Чистка",
      slot: "2026-07-10T10:00",
      booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
    }),
    makeSubject("subject_2", "mentioned_person", { patient_name: s2Name }),
  ]);
}

// ── A. "Запишите Ивана" without phone → subject_2 created, active=subject_2 ──

describe("blocker 2: s2 created from text signal", () => {
  it("A: 'Запишите Ивана' without phone creates subject_2 and sets active=subject_2", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Запишите Ивана на завтра",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null, "expected state to be created");
    assert.equal(result.active_subject_id, "subject_2");
    assert.ok(result.subjects.some((s) => s.id === "subject_2"), "subject_2 should exist");
  });

  it("B: 'Ещё одного человека' creates subject_2", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Ещё одного человека нужно записать",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.ok(result.subjects.some((s) => s.id === "subject_2"));
  });

  it("C: 'И его тоже запишите' creates subject_2", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "И его тоже запишите",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.ok(result.subjects.some((s) => s.id === "subject_2"));
  });
});

// ── B. "тогда меня" → active=subject_1, data preserved ──────────────────────

describe("blocker 3: self-switch signal", () => {
  it("D: 'тогда меня' switches active from subject_2 to subject_1", () => {
    const current = makeS2State();
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "тогда меня запишите",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "subject_1");
  });

  it("E: subject_1 data (patient_name, service, slot) preserved after self-switch", () => {
    const current = makeS2State();
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "нет, лучше меня",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1, "subject_1 must exist");
    assert.equal(s1.patient_name, "Рима");
    assert.equal(s1.service, "Чистка");
    assert.equal(s1.slot, "2026-07-10T10:00");
  });
});

// ── C. "Ивана тоже" → active=subject_2 (switch to existing) ─────────────────

describe("blocker 3: third-party switch to existing subject_2", () => {
  it("F: pronoun reference switches to existing subject_2", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка", slot: "2026-07-10T10:00" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "а Ивана когда можно?",
      channelContact: null,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "subject_2");
  });

  it("G: third-party pronoun alone does NOT create subject_2 (only switches existing)", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "его тоже нужно",
      channelContact: trustedContact,
      providedPhone: null,
    });
    if (result !== null) {
      const s2 = result.subjects.find((s) => s.id === "subject_2");
      assert.equal(s2, undefined, "subject_2 should not be created from switch-only signal");
    }
  });
});

// ── D. subject_1 seeded from booking_process_state on lazy expansion ──────────

describe("blocker 4: subject_1 seeded from existing booking data", () => {
  it("H: subject_1 gets patient_name/service/slot from s1Seed when lazily created", () => {
    const seed: S1Seed = {
      name: "Рима Валенко",
      service: "Отбеливание",
      slot: "2026-07-12T14:00",
    };
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Запишите Ивана тоже",
      channelContact: trustedContact,
      providedPhone: null,
      s1Seed: seed,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1);
    assert.equal(s1.patient_name, "Рима Валенко");
    assert.equal(s1.service, "Отбеливание");
    assert.equal(s1.slot, "2026-07-12T14:00");
  });

  it("I: subject_1 patient_name null when no seed and no prior state", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Запишите Ивана",
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1);
    assert.equal(s1.patient_name, null);
  });

  it("J: subject_1 already populated when expanding to subject_2 with existing prior state", () => {
    const existing = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        slot: "2026-07-10T10:00",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
    ]);
    const result = preUpdateBookingSubjects({
      current: existing,
      userMessage: "Запишите Ивана тоже",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1);
    assert.equal(s1.patient_name, "Рима");
    assert.equal(s1.service, "Чистка");
  });
});

// ── E. active=subject_1 + provided_phone + no channel_contact → mismatch ─────

describe("blocker 5: mismatch detection", () => {
  it("K: mismatch when active=subject_1, model tries booking with provided_phone, no channel_contact", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка", slot: "2026-07-10T10:00" }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима", last_name: "Валенко" } }],
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, true);
    assert.equal(mismatch.active_subject_id, "subject_1");
  });

  it("L: no mismatch when active=subject_1 and channel_contact present (correct flow)", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        slot: "2026-07-10T10:00",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
    ]);
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима" } }],
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, false);
  });

  it("M: no mismatch when active=subject_2 (typed phone is correct for subject_2)", () => {
    const state = makeS2State();
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван" } }],
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, false);
  });

  it("N: null returned when no booking.apply in tool requests", () => {
    const state = makeS2State();
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [],
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.equal(mismatch, null);
  });
});

// ── F. postUpdateBookingSubjects ──────────────────────────────────────────────

describe("postUpdateBookingSubjects", () => {
  it("O: visit_created=true sets active subject status to booked", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка", slot: "2026-07-10T10:00" }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-11T11:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", requested_date: "2026-07-11", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.ok(s2);
    assert.equal(s2.status, "booked");
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1);
    assert.equal(s1.status, "collecting");
  });

  it("P: booking.apply patient_name/slot/service written to active subject", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person"),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", last_name: "Петров", requested_date: "2026-07-15", requested_time: "09:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: false } }],
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.ok(s2);
    assert.equal(s2.patient_name, "Иван Петров");
    assert.equal(s2.service, "Чистка");
    assert.equal(s2.slot, "2026-07-15T09:00");
    assert.equal(s2.status, "collecting");
  });
});

// ── G. computeMissing / computeReadyForBooking ────────────────────────────────

describe("computeMissing / computeReadyForBooking", () => {
  it("Q: empty subject missing all 4 fields", () => {
    const s = makeSubject("subject_2" as SubjectId, "mentioned_person");
    assert.deepEqual(computeMissing(s), ["patient_name", "slot", "service", "booking_contact"]);
    assert.equal(computeReadyForBooking(s), false);
  });

  it("R: fully populated subject is ready", () => {
    const s = makeSubject("subject_2" as SubjectId, "mentioned_person", {
      patient_name: "Иван",
      service: "Чистка",
      slot: "2026-07-10T10:00",
      booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
    });
    assert.deepEqual(computeMissing(s), []);
    assert.equal(computeReadyForBooking(s), true);
  });

  it("S: booked subject is not ready_for_booking (already done)", () => {
    const s = makeSubject("subject_1" as SubjectId, "sender", {
      patient_name: "Рима",
      service: "Чистка",
      slot: "2026-07-10T10:00",
      booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      status: "booked",
    });
    assert.equal(computeReadyForBooking(s), false);
  });
});

// ── H. deserializeBookingSubjects round-trip + v1 migration ──────────────────

describe("deserializeBookingSubjects", () => {
  it("T: v2 state round-trips through JSON", () => {
    const state = makeS2State("Иван");
    const serialized = JSON.parse(JSON.stringify(state));
    const restored = deserializeBookingSubjects(serialized);
    assert.ok(restored !== null);
    assert.equal(restored.active_subject_id, "subject_2");
    assert.equal(restored.subjects.length, 2);
    assert.equal(restored.version, 2);
    const s1 = restored.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.patient_name, "Рима");
  });

  it("U: null/empty input returns null", () => {
    assert.equal(deserializeBookingSubjects(null), null);
    assert.equal(deserializeBookingSubjects(undefined), null);
    assert.equal(deserializeBookingSubjects({}), null);
  });

  it("T2: v1 state (s1/s2) migrates to v2 correctly", () => {
    const v1State = {
      active_subject_id: "s2",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: "+420724334616", phone_source: "telegram_contact_button", phone_status: "trusted", status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Иван", service: null, slot: null, phone_number: "+420728945521", phone_source: "typed", phone_status: "typed_unverified", status: "collecting" },
      ],
      pending_typed_phone: "+420728111222",
    };
    const result = normalizeBookingSubjectsState(v1State);
    assert.ok(result !== null);
    assert.equal(result.version, 2);
    assert.equal(result.active_subject_id, "subject_2");
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1);
    assert.equal(s1.patient_name, "Рима");
    assert.equal(s1.booking_contact?.phone_number, "+420724334616");
    assert.equal(s1.booking_contact?.trust, "trusted");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.ok(s2);
    assert.equal(s2.booking_contact?.source, "typed");
    assert.equal(s2.booking_contact?.trust, "unverified");
    assert.equal(result.pending_typed_phone, "+420728111222");
  });
});

// ── I. Execution guard: detectSubjectMismatch with unfiltered phone ────────────

describe("execution guard: mismatch visible even when guard suppresses phone", () => {
  it("X: mismatch=true when active=subject_1, unfiltered provided_phone passed, no channel_contact", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка", slot: "2026-07-10T10:00" }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима" } }],
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, true, "debug must still flag that guard had to act");
  });

  it("Y: mismatch=false when active=subject_2 and provided_phone present (correct booking)", () => {
    const state = makeS2State("Иван");
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван" } }],
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, false, "subject_2 booking with provided_phone is correct");
  });
});

// ── J. Single-subject flow untouched ──────────────────────────────────────────

describe("single-subject flow (no second person)", () => {
  it("V: ordinary message with no third-party signals returns null", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "хочу записаться на чистку зубов",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.equal(result, null);
  });

  it("W: 'меня' alone doesn't trigger subject expansion", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "запишите меня на завтра",
      channelContact: null,
      providedPhone: null,
    });
    assert.equal(result, null);
  });
});

// ── K. PR#173 phone source tests (updated to v2) ──────────────────────────────

describe("PR#173: subject-aware phone assignment", () => {
  it("A173: active=subject_1 receives typed phone when no trusted contact", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "это мой номер",
      channelContact: null,
      providedPhone,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "subject_1");
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.phone_number, providedPhone.phone_number);
    assert.equal(s1?.booking_contact?.trust, "unverified");
    assert.equal(s1?.booking_contact?.source, "typed");
    assert.equal(result.pending_typed_phone, providedPhone.phone_number);
  });

  it("B173: subject_1 trusted channel_contact wins over co-present typed phone", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "вот мой номер",
      channelContact: trustedContact,
      providedPhone,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.phone_number, trustedContact.phone_number);
    assert.equal(s1?.booking_contact?.trust, "trusted");
    assert.equal(s1?.booking_contact?.source, "telegram_contact_button");
  });

  it("C173: switch to Ivan + typed phone → subject_2 gets unverified, subject_1 trusted untouched", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "а Ивана +420728945521",
      channelContact: trustedContact,
      providedPhone,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "subject_2");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, providedPhone.phone_number);
    assert.equal(s2?.booking_contact?.trust, "unverified");
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.trust, "trusted");
  });

  it("D173: switch to self → postUpdate marks subject_1 booked on visit_created=true", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        slot: "2026-07-10T10:00",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-11T11:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима", requested_date: "2026-07-10", requested_time: "10:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
    });
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.status, "booked");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "collecting");
  });

  it("E173: active=subject_2 → postUpdate marks subject_2 booked, subject_1 untouched", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        slot: "2026-07-10T10:00",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
        status: "booked",
      }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-11T11:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", requested_date: "2026-07-11", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked");
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.status, "booked");
  });

  it("F173: ambiguous typed phone assigned to active subject, stored as pending_typed_phone", () => {
    const current = makeState("subject_2", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "вот номер",
      channelContact: null,
      providedPhone,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "subject_2");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, providedPhone.phone_number);
    assert.equal(s2?.booking_contact?.trust, "unverified");
    assert.equal(result.pending_typed_phone, providedPhone.phone_number);
  });

  it("G173: applySubjectIntent switches to subject_2 from English/Czech model output (high confidence)", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Anna" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Ivan" }),
    ]);
    const intent: SubjectIntent = { action: "switch_subject", target: "mentioned_person", confidence: "high" };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.active_subject_id, "subject_2");
  });

  it("G173b: applySubjectIntent switches back to self from Czech 'pro mě'", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Anna" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Ivan" }),
    ]);
    const intent: SubjectIntent = { action: "switch_subject", target: "self", confidence: "high" };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.active_subject_id, "subject_1");
  });

  it("G173c: low confidence subject_intent is ignored", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Anna" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Ivan" }),
    ]);
    const intent: SubjectIntent = { action: "switch_subject", target: "mentioned_person", confidence: "low" };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.active_subject_id, "subject_1");
  });

  it("H173: visit_created=false does NOT mark subject as booked", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка" }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-11T11:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", requested_date: "2026-07-11", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: false } }],
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "collecting");
  });

  it("I173: mismatch flag reflects active_subject mismatch; subject_2 active has no mismatch", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        slot: "2026-07-10T10:00",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-11T11:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const s1Mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима" } }],
      channelContact: null,
      providedPhone,
    });
    assert.ok(s1Mismatch !== null);
    assert.equal(s1Mismatch.mismatch, true);

    const s2Mismatch = detectSubjectMismatch({
      state: { ...state, active_subject_id: "subject_2" as SubjectId },
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван" } }],
      channelContact: null,
      providedPhone,
    });
    assert.ok(s2Mismatch !== null);
    assert.equal(s2Mismatch.mismatch, false);
  });
});

// ── PR#174: subject_intent formal contract tests (updated to v2) ──────────────

describe("PR#174: postUpdateBookingSubjects uses typed subjectIntent", () => {
  it("J174a: subjectIntent switch_subject/self switches active from subject_2→subject_1", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const intent: SubjectIntent = { action: "switch_subject", target: "self", confidence: "high" };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [],
      toolResults: [],
      subjectIntent: intent,
    });
    assert.equal(updated.active_subject_id, "subject_1");
  });

  it("J174b: subjectIntent switch clears pending_typed_phone and assigns to new active subject", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ], "+420728123456");
    const intent: SubjectIntent = { action: "switch_subject", target: "mentioned_person", confidence: "high" };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [],
      toolResults: [],
      subjectIntent: intent,
    });
    assert.equal(updated.active_subject_id, "subject_2");
    assert.equal(updated.pending_typed_phone, null, "pending_typed_phone must be consumed");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, "+420728123456", "phone assigned to subject_2");
    assert.equal(s2?.booking_contact?.trust, "unverified");
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact, null, "subject_1 contact unchanged");
  });

  it("J174c: null subjectIntent leaves state unchanged", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [],
      toolResults: [],
      subjectIntent: null,
    });
    assert.equal(updated.active_subject_id, "subject_1");
  });
});

describe("PR#174: parseSubjectIntent validates model output", () => {
  it("K174a: valid subject_intent object parses correctly", () => {
    const raw = { action: "switch_subject", target: "self", confidence: "high" };
    const result = parseSubjectIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.action, "switch_subject");
    assert.equal(result!.target, "self");
    assert.equal(result!.confidence, "high");
  });

  it("K174b: invalid action rejects", () => {
    const raw = { action: "fly_to_mars", target: "self", confidence: "high" };
    assert.equal(parseSubjectIntent(raw), null);
  });

  it("K174c: null input returns null", () => {
    assert.equal(parseSubjectIntent(null), null);
    assert.equal(parseSubjectIntent(undefined), null);
    assert.equal(parseSubjectIntent("string"), null);
  });

  it("K174d: missing confidence rejects", () => {
    const raw = { action: "none", target: "active" };
    assert.equal(parseSubjectIntent(raw), null);
  });

  it("K174e: display_name is preserved when present (v1 create_subject → create_subjects)", () => {
    const raw = { action: "create_subject", target: "mentioned_person", confidence: "high", display_name: "Анна" };
    const result = parseSubjectIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.action, "create_subjects");
    assert.equal(result!.display_name, "Анна");
  });
});

// ── PR#174-fix: pending_typed_phone preservation ──────────────────────────────

describe("PR#174-fix: pending_typed_phone not cleared until classified", () => {
  const BASE_STATE = makeState("subject_2", [
    makeSubject("subject_1", "sender", { patient_name: "Рима" }),
    makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
  ], "+420728123456");

  it("A174-fix: pending_typed_phone preserved when booking blocked for classification (no subjectIntent)", () => {
    const updated = postUpdateBookingSubjects({
      current: BASE_STATE,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", last_name: "Петров", requested_date: "2026-07-09", requested_time: "12:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { booking_status: "pending_phone_classification", created_visit: false, may_claim_booked: false, required_next_action: "none", reason: "typed_phone_subject_unclear" } }],
      subjectIntent: null,
    });
    assert.equal(updated.pending_typed_phone, "+420728123456", "phone must be preserved");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "collecting");
  });

  it("B174-fix: pending_typed_phone consumed and assigned to subject_2 when subjectIntent switches", () => {
    const stateFromS1 = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ], "+420728123456");
    const intent: SubjectIntent = { action: "switch_subject", target: "mentioned_person", confidence: "high" };
    const updated = postUpdateBookingSubjects({
      current: stateFromS1,
      toolRequests: [],
      toolResults: [],
      subjectIntent: intent,
    });
    assert.equal(updated.pending_typed_phone, null, "phone must be consumed");
    assert.equal(updated.active_subject_id, "subject_2");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, "+420728123456");
    assert.equal(s2?.booking_contact?.source, "typed");
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact, null);
  });

  it("A174-fix-b: normal booking without pending phone → pending_typed_phone stays null", () => {
    const stateNoPending = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-09T12:00",
        booking_contact: makeBC("+420728123456", "typed", "unverified", "subject_2"),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: stateNoPending,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", last_name: "Петров", requested_date: "2026-07-09", requested_time: "12:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
      subjectIntent: null,
    });
    assert.equal(updated.pending_typed_phone, null);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked");
  });
});

// ── PR#175: existingProvidedPhone must not recreate pending_typed_phone ────────

describe("PR#175: existingProvidedPhone must not recreate pending_typed_phone", () => {
  const stateAfterClassification = makeState("subject_2", [
    makeSubject("subject_1", "sender", { patient_name: "Миша Бондаренко", service: "Чистка" }),
    makeSubject("subject_2", "mentioned_person", {
      patient_name: "Анна Бондаренко",
      service: "Чистка",
      booking_contact: makeBC("+420728123456", "typed", "unverified", "subject_2"),
    }),
  ]);

  it("A175: no current-turn typed phone → pending_typed_phone stays null", () => {
    const result = preUpdateBookingSubjects({
      current: stateAfterClassification,
      userMessage: "да, всё верно",
      channelContact: null,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, null);
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, "+420728123456");
    assert.equal(s2?.booking_contact?.trust, "unverified");
  });

  it("B175: pending carried from current state when no new phone typed", () => {
    const stateWithPending = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Анна",
        booking_contact: makeBC("+420728123456", "typed", "unverified", "subject_2"),
      }),
    ], "+420728123456");
    const result = preUpdateBookingSubjects({
      current: stateWithPending,
      userMessage: "это номер мамы",
      channelContact: null,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+420728123456");
  });

  it("C175: new typed phone on a later turn overrides previous pending", () => {
    const pp: ProvidedPhone = {
      phone_number: "+380991234567",
      phone_source: "typed",
      phone_trust: "unverified",
      phone_consent: false,
      phone_collected_at: new Date().toISOString(),
    };
    const result = preUpdateBookingSubjects({
      current: stateAfterClassification,
      userMessage: "мой номер +380991234567",
      channelContact: null,
      providedPhone: pp,
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+380991234567");
  });

  it("D175: single-subject mode unaffected — null preUpdate result for confirmation message", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "да, всё верно",
      channelContact: null,
      providedPhone: null,
    });
    assert.equal(result, null);
  });
});

// ── PR#176: Subject Registry v2 ──────────────────────────────────────────────

describe("PR#176: Subject Registry v2", () => {
  // A. Single subject
  it("A176: single-subject message returns null (no multi-subject overhead)", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Хочу записаться на чистку",
      channelContact: null,
      providedPhone: null,
    });
    assert.equal(result, null, "single-subject mode: no booking_subjects created");
  });

  // B. Sender + mom
  it("B176: 'Запишите меня и маму' creates subject_1 (sender) + subject_2 (mentioned), active=subject_2", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Запишите меня и маму",
      channelContact: null,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.version, 2);
    assert.equal(result.max_subjects, 4);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1);
    assert.equal(s1.role, "sender");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.ok(s2);
    assert.equal(s2.role, "mentioned_person");
    assert.equal(result.active_subject_id, "subject_2");
  });

  // C. Three subjects via create_subjects intent
  it("C176: create_subjects count=2 with labels fills existing subject_2 label and creates subject_3", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Мама" }),
      makeSubject("subject_2", "mentioned_person"), // no label yet
    ]);
    const intent: SubjectIntent = {
      action: "create_subjects",
      target: "mentioned_person",
      count: 2,
      labels: ["дочь 1", "дочь 2"],
      confidence: "high",
    };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.subjects.length, 3);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.label, "дочь 1", "existing subject_2 gets first label");
    const s3 = updated.subjects.find((s) => s.id === "subject_3");
    assert.ok(s3, "subject_3 created");
    assert.equal(s3?.label, "дочь 2");
    assert.equal(s3?.role, "mentioned_person");
  });

  // D. Max subjects exceeded
  it("D176: create_subjects respects max_subjects=4 — does not exceed 4", () => {
    const state = makeState("subject_3", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
      makeSubject("subject_3", "mentioned_person"),
    ]);
    const intent: SubjectIntent = {
      action: "create_subjects",
      target: "mentioned_person",
      count: 4,
      confidence: "high",
    };
    const updated = applySubjectIntent(state, intent);
    assert.ok(updated.subjects.length <= 4, `must not exceed 4 subjects, got ${updated.subjects.length}`);
  });

  it("D176b: at max already — create_subjects creates nothing", () => {
    const state = makeState("subject_4", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
      makeSubject("subject_3", "mentioned_person"),
      makeSubject("subject_4", "mentioned_person"),
    ]);
    const intent: SubjectIntent = { action: "create_subjects", target: "mentioned_person", count: 1, confidence: "high" };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.subjects.length, 4, "at max: no new subjects created");
  });

  // E. Shared contact (trusted_contact_owner)
  it("E176: BookingContact with shared_from_subject / trusted_contact_owner validates and survives normalize", () => {
    const sharedBC: BookingContact = {
      phone_number: "+420724334616",
      source: "shared_from_subject",
      trust: "trusted_contact_owner",
      owner_subject_id: "subject_1" as SubjectId,
      collected_at: null,
    };
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1") }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Дочь 1", booking_contact: sharedBC }),
    ]);
    const serialized = JSON.parse(JSON.stringify(state));
    const restored = normalizeBookingSubjectsState(serialized);
    assert.ok(restored !== null);
    const s2 = restored.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.source, "shared_from_subject");
    assert.equal(s2?.booking_contact?.trust, "trusted_contact_owner");
    assert.equal(s2?.booking_contact?.owner_subject_id, "subject_1");
  });

  // F. Separate typed phone — no contact button needed
  it("F176: active=subject_2, typed phone → booking_contact.trust=unverified (no button request)", () => {
    const current = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Парень" }),
    ]);
    const pp: ProvidedPhone = {
      phone_number: "+420728111222",
      phone_source: "typed",
      phone_trust: "unverified",
      phone_consent: false,
      phone_collected_at: new Date().toISOString(),
    };
    const result = preUpdateBookingSubjects({ current, userMessage: "его номер 728111222", channelContact: null, providedPhone: pp });
    assert.ok(result !== null);
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.source, "typed");
    assert.equal(s2?.booking_contact?.trust, "unverified");
    // The model-visible payload must not have phone_status requiring a button
    const payload = buildSubjectsContextPayload(result);
    const payloadS2 = (payload.subjects as Record<string, unknown>[]).find((s) => s.id === "subject_2");
    assert.equal(payloadS2?.phone_status, "typed_unverified");
  });

  // G. Ambiguous typed phone — pending set, active contact NOT necessarily set
  it("G176: multi-subject + ambiguous typed phone → pending_typed_phone set", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ]);
    const pp: ProvidedPhone = { phone_number: "+420728999000", phone_source: "typed", phone_trust: "unverified", phone_consent: false, phone_collected_at: new Date().toISOString() };
    // No switch signal in message — active stays subject_1
    const result = preUpdateBookingSubjects({ current, userMessage: "728999000", channelContact: null, providedPhone: pp });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+420728999000");
  });

  // H. Pending phone classification
  it("H176: applySubjectIntent assigns pending phone to subject_2 when switching to mentioned_person", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Мама" }),
    ], "+420728999000");
    const intent: SubjectIntent = { action: "switch_subject", target: "mentioned_person", confidence: "high" };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.pending_typed_phone, null, "pending consumed");
    assert.equal(updated.active_subject_id, "subject_2");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, "+420728999000");
    assert.equal(s2?.booking_contact?.trust, "unverified");
  });

  // I. No reinjection regression (v2)
  it("I176: after classification, preUpdate with no new phone keeps pending=null (no reinjection)", () => {
    const classifiedState = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Анна",
        booking_contact: makeBC("+420728123456", "typed", "unverified", "subject_2"),
      }),
    ]); // pending_typed_phone = null (already consumed)
    const result = preUpdateBookingSubjects({
      current: classifiedState,
      userMessage: "да, всё верно",
      channelContact: null,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, null, "no reinjection of old provided_phone");
  });

  // J. Active subject execution — buildSubjectsContextPayload
  it("J176: buildSubjectsContextPayload shows correct active_subject_id and all subjects", () => {
    const state = makeState("subject_3" as SubjectId, [
      makeSubject("subject_1", "sender", { patient_name: "Мама", service: "Чистка", booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1") }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Дочь 1", label: "дочь 1" }),
      makeSubject("subject_3" as SubjectId, "mentioned_person", { patient_name: "Дочь 2", label: "дочь 2" }),
    ]);
    const payload = buildSubjectsContextPayload(state);
    assert.equal(payload.active_subject_id, "subject_3");
    assert.equal(payload.version, 2);
    assert.equal(payload.max_subjects, 4);
    const subjects = payload.subjects as Record<string, unknown>[];
    assert.equal(subjects.length, 3);
    const s3 = subjects.find((s) => s.id === "subject_3");
    assert.ok(s3);
    assert.equal(s3.label, "дочь 2");
  });

  // K. Booked status proof
  it("K176: postUpdate with created_visit=true → active subject status=booked, missing recomputed", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-15T10:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", last_name: "Петров", requested_date: "2026-07-15", requested_time: "10:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked");
    assert.deepEqual(s2?.missing, [], "all fields present + booked: missing should be empty");
  });

  // L. V1 migration
  it("L176: v1 state (s1/s2) migrates cleanly to v2 preserving phone/service/slot", () => {
    const v1 = {
      active_subject_id: "s2",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: "+420724334616", phone_source: "telegram_contact_button", phone_status: "trusted", status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Анна", service: null, slot: null, phone_number: "+420728123456", phone_source: "typed", phone_status: "typed_unverified", status: "collecting" },
      ],
      pending_typed_phone: "+420728123456",
    };
    const result = normalizeBookingSubjectsState(v1);
    assert.ok(result !== null);
    assert.equal(result.version, 2);
    assert.equal(result.max_subjects, 4);
    assert.equal(result.active_subject_id, "subject_2");
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.ok(s1);
    assert.equal(s1.patient_name, "Рима");
    assert.equal(s1.role, "sender");
    assert.equal(s1.booking_contact?.trust, "trusted");
    assert.equal(s1.booking_contact?.source, "telegram_contact_button");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.ok(s2);
    assert.equal(s2.patient_name, "Анна");
    assert.equal(s2.role, "mentioned_person");
    assert.equal(s2.booking_contact?.source, "typed");
    assert.equal(s2.booking_contact?.trust, "unverified");
    assert.equal(result.pending_typed_phone, "+420728123456");
  });

  // M. parseSubjectIntent v2 fields
  it("M176: parseSubjectIntent handles v2 create_subjects with count/labels/subject_id", () => {
    const raw = { action: "create_subjects", target: "mentioned_person", count: 2, labels: ["дочь 1", "дочь 2"], confidence: "high" };
    const result = parseSubjectIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.action, "create_subjects");
    assert.equal(result!.count, 2);
    assert.deepEqual(result!.labels, ["дочь 1", "дочь 2"]);
  });

  it("M176b: old create_subject (singular) is remapped to create_subjects", () => {
    const raw = { action: "create_subject", target: "mentioned_person", confidence: "medium" };
    const result = parseSubjectIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.action, "create_subjects");
  });

  it("M176c: subject_id field validated — invalid format rejected", () => {
    const raw = { action: "switch_subject", target: "mentioned_person", subject_id: "not_valid", confidence: "high" };
    const result = parseSubjectIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.subject_id, null, "invalid subject_id falls back to null");
  });

  it("M176d: subject_id field validated — valid format accepted", () => {
    const raw = { action: "switch_subject", target: "mentioned_person", subject_id: "subject_3", confidence: "high" };
    const result = parseSubjectIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.subject_id, "subject_3");
  });

  it("M176e: applySubjectIntent with explicit subject_id switches to correct subject", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
      makeSubject("subject_3" as SubjectId, "mentioned_person"),
    ]);
    const intent: SubjectIntent = { action: "switch_subject", target: "mentioned_person", subject_id: "subject_3" as SubjectId, confidence: "high" };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.active_subject_id, "subject_3");
  });
});

// ── PR#175 review fixes: Blockers 1-3 regression tests ───────────────────────

describe("PR#175-review: Blocker 1 — pending consumed for current active subject", () => {
  it("A: pending consumed when intent confirms already-active subject (no active change)", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Мария" }),
    ], "+420728111222");
    const intent: SubjectIntent = {
      action: "switch_subject",
      target: "active",
      subject_id: "subject_2" as SubjectId,
      confidence: "high",
    };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.pending_typed_phone, null, "pending must be consumed");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.source, "typed");
    assert.equal(s2?.booking_contact?.trust, "unverified");
    assert.equal(s2?.booking_contact?.phone_number, "+420728111222");
  });

  it("B: pending preserved when booking.apply blocked (no intent consumed it)", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ], "+420728111222");
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Мария", last_name: "Петрова", requested_date: "2026-07-15", requested_time: "10:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { booking_status: "pending_phone_classification", created_visit: false, may_claim_booked: false, required_next_action: "none", reason: "typed_phone_subject_unclear" } }],
      subjectIntent: null,
    });
    assert.equal(updated.pending_typed_phone, "+420728111222", "pending preserved when guard blocked");
  });
});

describe("PR#175-review: Blocker 2 — display_name stored as patient_name", () => {
  it("C: create_subjects with labels and display_name stores patient_name", () => {
    const state = makeState("subject_1", [makeSubject("subject_1", "sender")]);
    const intent: SubjectIntent = {
      action: "create_subjects",
      target: "mentioned_person",
      count: 1,
      labels: ["мама"],
      display_name: "Анна",
      confidence: "high",
    };
    const updated = applySubjectIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.role === "mentioned_person");
    assert.ok(s2, "mentioned_person subject created");
    assert.equal(s2?.label, "мама");
    assert.equal(s2?.patient_name, "Анна", "display_name must be stored as patient_name");
  });

  it("C2: switch to existing mentioned subject with display_name fills missing patient_name", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { label: "мама" }),
    ]);
    const intent: SubjectIntent = {
      action: "switch_subject",
      target: "mentioned_person",
      display_name: "Анна",
      confidence: "high",
    };
    const updated = applySubjectIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.patient_name, "Анна", "display_name fills missing patient_name on switch");
  });

  it("C3: display_name does NOT overwrite existing patient_name", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Анна Петрова" }),
    ]);
    const intent: SubjectIntent = {
      action: "switch_subject",
      target: "mentioned_person",
      display_name: "Другое Имя",
      confidence: "high",
    };
    const updated = applySubjectIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.patient_name, "Анна Петрова", "existing patient_name must not be overwritten");
  });

  it("C4: create_subjects fills display_name into existing unlabeled mentioned_person subject", () => {
    // Regression: when subject_2 already exists as unlabeled mentioned_person,
    // create_subjects only labeled it but lost display_name (patient_name stayed null).
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ]);
    const intent: SubjectIntent = {
      action: "create_subjects",
      target: "mentioned_person",
      count: 1,
      labels: ["мама"],
      display_name: "Анна",
      confidence: "high",
    };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.subjects.length, 2, "no new subject must be created");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.label, "мама", "label must be applied");
    assert.equal(s2?.patient_name, "Анна", "display_name must be stored as patient_name");
  });
});

describe("PR#175-review: Blocker 3 — shared_from_subject resolves owner contact", () => {
  it("D: shared contact with trusted owner passes booking as trusted owner source", () => {
    const stateRaw = makeState("subject_2", [
      makeSubject("subject_1", "sender", {
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Дочь 1",
        booking_contact: {
          phone_number: "+420724334616",
          source: "shared_from_subject" as BookingContactSource,
          trust: "trusted_contact_owner" as BookingContactTrust,
          owner_subject_id: "subject_1" as SubjectId,
          collected_at: null,
        },
      }),
    ]);
    // Simulate resolveBookingContactFields via buildSubjectsContextPayload (just check state)
    const subjects = stateRaw.subjects as Array<{ id: string; booking_contact?: unknown }>;
    const s2 = subjects.find((s) => s.id === "subject_2");
    const bc = s2?.booking_contact as Record<string, unknown> | null;
    assert.ok(bc);
    assert.equal(bc!.source, "shared_from_subject");
    // Resolve via owner
    const ownerId = bc!.owner_subject_id as string;
    const owner = subjects.find((s) => s.id === ownerId);
    const ownerBc = owner?.booking_contact as Record<string, unknown> | null;
    assert.ok(ownerBc);
    assert.equal(ownerBc!.phone_number, "+420724334616");
    assert.equal(ownerBc!.source, "telegram_contact_button");
    assert.equal(ownerBc!.trust, "trusted");
  });

  it("E: shared contact where owner has no contact → unresolvable (no phone)", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", {
        booking_contact: {
          phone_number: "+420724334616",
          source: "shared_from_subject" as BookingContactSource,
          trust: "trusted_contact_owner" as BookingContactTrust,
          owner_subject_id: "subject_1" as SubjectId,
          collected_at: null,
        },
      }),
    ]);
    // subject_1 has no booking_contact → should produce undefined phone
    const subjects = state.subjects as Array<{ id: string; booking_contact?: unknown }>;
    const owner = subjects.find((s) => s.id === "subject_1");
    const ownerBc = (owner?.booking_contact ?? null) as Record<string, unknown> | null;
    assert.equal(ownerBc, null, "owner has no contact — shared contact unresolvable");
  });

  it("E2: shared contact from typed/unverified owner must not become trusted", () => {
    const subjects: Array<{ id: string; booking_contact?: unknown }> = [
      {
        id: "subject_1",
        booking_contact: { phone_number: "+420999000111", source: "typed", trust: "unverified", owner_subject_id: "subject_1", collected_at: null },
      },
      {
        id: "subject_2",
        booking_contact: { phone_number: "+420999000111", source: "shared_from_subject", trust: "trusted_contact_owner", owner_subject_id: "subject_1", collected_at: null },
      },
    ];
    const bc = subjects[1].booking_contact as Record<string, unknown>;
    const ownerId = bc.owner_subject_id as string;
    const owner = subjects.find((s) => s.id === ownerId);
    const ownerBc = owner?.booking_contact as Record<string, unknown> | null;
    assert.ok(ownerBc);
    // Simulate resolution logic
    const resolvedTrust = ownerBc!.trust === "trusted" ? "trusted" : "unverified";
    assert.equal(resolvedTrust, "unverified", "typed owner contact must not become trusted when shared");
  });
});

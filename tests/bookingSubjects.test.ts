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
} from "../src/runtime/bookingSubjectsState.ts";
import type {
  BookingSubjectsState,
  BookingSubject,
  S1Seed,
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

function makeS2State(s2Name: string | null = "Иван"): BookingSubjectsState {
  return {
    active_subject_id: "s2",
    subjects: [
      { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      { id: "s2", label: "mentioned_person", name: s2Name, service: null, slot: null, phone_number: null, phone_status: null, status: "collecting" },
    ],
  };
}

// ── A. "Запишите Ивана" without phone → s2 created, active=s2 ─────────────

describe("blocker 2: s2 created from text signal", () => {
  it("A: 'Запишите Ивана' without phone creates s2 and sets active=s2", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Запишите Ивана на завтра",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null, "expected state to be created");
    assert.equal(result.active_subject_id, "s2");
    assert.ok(result.subjects.some((s) => s.id === "s2"), "s2 should exist");
  });

  it("B: 'Ещё одного человека' creates s2", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Ещё одного человека нужно записать",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.ok(result.subjects.some((s) => s.id === "s2"));
  });

  it("C: 'И его тоже запишите' creates s2", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "И его тоже запишите",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.ok(result.subjects.some((s) => s.id === "s2"));
  });
});

// ── B. "тогда меня" → active=s1, s1 data preserved ───────────────────────

describe("blocker 3: self-switch signal", () => {
  it("D: 'тогда меня' switches active from s2 to s1", () => {
    const current = makeS2State();
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "тогда меня запишите",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "s1");
  });

  it("E: s1 data (name, service, slot) preserved after self-switch", () => {
    const current = makeS2State();
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "нет, лучше меня",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "s1");
    assert.ok(s1, "s1 must exist");
    assert.equal(s1.name, "Рима");
    assert.equal(s1.service, "Чистка");
    assert.equal(s1.slot, "2026-07-10T10:00");
  });
});

// ── C. "Ивана тоже" → active=s2 (switch to existing s2) ─────────────────

describe("blocker 3: third-party switch to existing s2", () => {
  it("F: pronoun reference switches to existing s2", () => {
    const current: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: null, phone_status: null, status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Иван", service: null, slot: null, phone_number: null, phone_status: null, status: "collecting" },
      ],
    };
    const result = preUpdateBookingSubjects({
      current,
      userMessage: "а Ивана когда можно?",
      channelContact: null,
      providedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "s2");
  });

  it("G: third-party pronoun alone does NOT create s2 (only switches existing)", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "его тоже нужно",
      channelContact: trustedContact,
      providedPhone: null,
    });
    // "его тоже нужно" — no explicit booking intent
    // "его тоже нужно" doesn't match THIRD_PARTY_CREATE_REGEXPS which require "запишите" or strong booking intent
    // So result is null OR subjects may exist depending on regex — let's just check no crash
    // The THIRD_PARTY_SWITCH regexp includes /\b(его|её|...)\b/ so it would match third_party_switch
    // BUT no existing s2 → switch is ignored → should return null
    // Actually looking at the code: hasSecondPersonSignal checks providedPhone || third_party_create || third_party_switch || existing s2
    // "его тоже нужно" → signal=third_party_switch (if it matches one of THIRD_PARTY_SWITCH_REGEXPS)
    // hasSecondPersonSignal is true → state is created but activeId stays s1 (since signal=third_party_switch and no s2)
    // Let's verify behavior: if s2 doesn't exist, switch doesn't change active
    if (result !== null) {
      // If state was created, s2 should NOT exist (no create signal)
      const s2 = result.subjects.find((s) => s.id === "s2");
      assert.equal(s2, undefined, "s2 should not be created from switch-only signal");
    }
    // Either null (no hasSecondPersonSignal) or only s1 (switch signal but no s2)
  });
});

// ── D. s1 seeded from booking_process_state on lazy expansion ─────────────

describe("blocker 4: s1 seeded from existing booking data", () => {
  it("H: s1 gets name/service/slot from s1Seed when lazily created", () => {
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
    const s1 = result.subjects.find((s) => s.id === "s1");
    assert.ok(s1);
    assert.equal(s1.name, "Рима Валенко");
    assert.equal(s1.service, "Отбеливание");
    assert.equal(s1.slot, "2026-07-12T14:00");
  });

  it("I: s1 name null when no seed and no prior state", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Запишите Ивана",
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "s1");
    assert.ok(s1);
    assert.equal(s1.name, null);
  });

  it("J: s1 already populated when expanding to s2 with existing prior state", () => {
    const existing: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      ],
    };
    const result = preUpdateBookingSubjects({
      current: existing,
      userMessage: "Запишите Ивана тоже",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "s1");
    assert.ok(s1);
    assert.equal(s1.name, "Рима");
    assert.equal(s1.service, "Чистка");
  });
});

// ── E. active=s1 + provided_phone + no channel_contact → mismatch ─────────

describe("blocker 5: mismatch detection", () => {
  it("K: mismatch when active=s1, model tries booking with provided_phone, no channel_contact", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: null, phone_status: null, status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Иван", service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
      ],
    };
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима", last_name: "Валенко" } }],
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, true);
    assert.equal(mismatch.active_subject_id, "s1");
  });

  it("L: no mismatch when active=s1 and channel_contact present (correct flow)", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      ],
    };
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима" } }],
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, false);
  });

  it("M: no mismatch when active=s2 (typed phone is correct for s2)", () => {
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

  it("N: no mismatch returned when no booking.apply in tool requests", () => {
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

// ── F. postUpdateBookingSubjects — booking.apply data applied to active subject ──

describe("postUpdateBookingSubjects", () => {
  it("O: visit_created=true sets active subject status to booked", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s2",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: null, phone_status: null, status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Иван", service: "Чистка", slot: "2026-07-11T11:00", phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
      ],
    };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", requested_date: "2026-07-11", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
    });
    const s2 = updated.subjects.find((s) => s.id === "s2");
    assert.ok(s2);
    assert.equal(s2.status, "booked");
    // s1 should be untouched
    const s1 = updated.subjects.find((s) => s.id === "s1");
    assert.ok(s1);
    assert.equal(s1.status, "collecting");
  });

  it("P: booking.apply name/slot/service written to active subject", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s2",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: null, slot: null, phone_number: null, phone_status: null, status: "collecting" },
        { id: "s2", label: "mentioned_person", name: null, service: null, slot: null, phone_number: null, phone_status: null, status: "collecting" },
      ],
    };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", last_name: "Петров", requested_date: "2026-07-15", requested_time: "09:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: false } }],
    });
    const s2 = updated.subjects.find((s) => s.id === "s2");
    assert.ok(s2);
    assert.equal(s2.name, "Иван Петров");
    assert.equal(s2.service, "Чистка");
    assert.equal(s2.slot, "2026-07-15T09:00");
    assert.equal(s2.status, "collecting");
  });
});

// ── G. computeMissing / computeReadyForBooking ─────────────────────────────

describe("computeMissing / computeReadyForBooking", () => {
  it("Q: empty subject missing all 4 fields", () => {
    const s: BookingSubject = { id: "s2", label: "mentioned_person", name: null, service: null, slot: null, phone_number: null, phone_status: null, status: "collecting" };
    assert.deepEqual(computeMissing(s), ["name", "slot", "service", "phone"]);
    assert.equal(computeReadyForBooking(s), false);
  });

  it("R: fully populated subject is ready", () => {
    const s: BookingSubject = { id: "s2", label: "mentioned_person", name: "Иван", service: "Чистка", slot: "2026-07-10T10:00", phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" };
    assert.deepEqual(computeMissing(s), []);
    assert.equal(computeReadyForBooking(s), true);
  });

  it("S: booked subject is not ready_for_booking (already done)", () => {
    const s: BookingSubject = { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: "+420724334616", phone_status: "trusted", status: "booked" };
    assert.equal(computeReadyForBooking(s), false);
  });
});

// ── H. deserializeBookingSubjects round-trip ───────────────────────────────

describe("deserializeBookingSubjects", () => {
  it("T: valid state round-trips through JSON", () => {
    const state = makeS2State("Иван");
    const serialized = JSON.parse(JSON.stringify(state));
    const restored = deserializeBookingSubjects(serialized);
    assert.ok(restored !== null);
    assert.equal(restored.active_subject_id, "s2");
    assert.equal(restored.subjects.length, 2);
    const s1 = restored.subjects.find((s) => s.id === "s1");
    assert.equal(s1?.name, "Рима");
  });

  it("U: null input returns null", () => {
    assert.equal(deserializeBookingSubjects(null), null);
    assert.equal(deserializeBookingSubjects(undefined), null);
    assert.equal(deserializeBookingSubjects({}), null);
  });
});

// ── I. Execution guard: detectSubjectMismatch with unfiltered phone ───────────
// The orchestrator passes providedPhoneForTurnOuter (pre-guard) to detectSubjectMismatch
// so that debug accurately reflects when the guard had to suppress the phone.

describe("execution guard: mismatch visible even when guard suppresses phone", () => {
  it("X: mismatch=true when active=s1, unfiltered provided_phone passed, no channel_contact", () => {
    // Simulate what the orchestrator does: pass providedPhoneForTurnOuter (unfiltered) to
    // detectSubjectMismatch even though runtimeTurnInput.provided_phone was cleared (active=s1).
    const state: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", phone_number: null, phone_status: null, status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Иван", service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
      ],
    };
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима" } }],
      channelContact: null,
      // This is the UNFILTERED providedPhone — the guard suppressed it from tool execution,
      // but we still pass it here so mismatch detection shows the corrected case.
      providedPhone: providedPhone,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, true, "debug must still flag that guard had to act");
  });

  it("Y: mismatch=false when active=s2 and provided_phone present (correct s2 booking)", () => {
    const state = makeS2State("Иван");
    const mismatch = detectSubjectMismatch({
      state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван" } }],
      channelContact: null,
      providedPhone: providedPhone,
    });
    assert.ok(mismatch !== null);
    assert.equal(mismatch.mismatch, false, "s2 booking with provided_phone is correct — no mismatch");
  });
});

// ── J. Single-subject flow untouched ──────────────────────────────────────

describe("single-subject flow (no second person)", () => {
  it("V: ordinary message with no third-party signals returns null (no subjects state)", () => {
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectSwitchSignal,
  preUpdateBookingSubjects,
  postUpdateBookingSubjects,
  buildSubjectsContextPayload,
  computeMissing,
  computeReadyForBooking,
} from "../src/runtime/bookingSubjectsState.ts";
import type { BookingSubjectsState } from "../src/runtime/bookingSubjectsState.ts";
import type { ChannelContact, ProvidedPhone } from "../src/runtime/openaiRuntimeAgent.ts";

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
  phone_collected_at: "2026-07-08T12:00:00.000Z",
};

const noTools = { toolRequests: [], toolResults: [] };

// ── helpers ────────────────────────────────────────────────────────────────

function subjectById(state: BookingSubjectsState, id: "s1" | "s2") {
  return state.subjects.find((s) => s.id === id) ?? null;
}

// ── A. Рима gives name/service/slot ──────────────────────────────────────

describe("A: single-subject baseline — no subjects state created", () => {
  it("A1: no provided_phone → preUpdate returns null (old flow unchanged)", () => {
    const result = preUpdateBookingSubjects({
      current: null,
      userMessage: "Рима Астрицкая, чистка, 14:00 завтра",
      channelContact: trustedContact,
      providedPhone: null,
    });
    assert.equal(result, null);
  });
});

// ── B. User says "запишите Ивана" → typed phone triggers s2 ──────────────

describe("B-C: typed phone creates s2 and switches active subject", () => {
  it("B1: provided_phone → state is created, s2 exists", () => {
    const state = preUpdateBookingSubjects({
      current: null,
      userMessage: "728945521",
      channelContact: trustedContact,
      providedPhone,
    });
    assert.ok(state !== null);
    assert.ok(state!.subjects.some((s) => s.id === "s2"));
  });

  it("C1: active_subject_id becomes s2 on first typed phone", () => {
    const state = preUpdateBookingSubjects({
      current: null,
      userMessage: "728945521",
      channelContact: trustedContact,
      providedPhone,
    });
    assert.equal(state!.active_subject_id, "s2");
  });

  it("C2: s2 has phone_status=typed_unverified and correct phone_number", () => {
    const state = preUpdateBookingSubjects({
      current: null,
      userMessage: "728945521",
      channelContact: trustedContact,
      providedPhone,
    });
    const s2 = subjectById(state!, "s2")!;
    assert.equal(s2.phone_status, "typed_unverified");
    assert.equal(s2.phone_number, "+420728945521");
  });

  it("C3: s1 has phone_status=trusted from channel_contact", () => {
    const state = preUpdateBookingSubjects({
      current: null,
      userMessage: "728945521",
      channelContact: trustedContact,
      providedPhone,
    });
    const s1 = subjectById(state!, "s1")!;
    assert.equal(s1.phone_status, "trusted");
    assert.equal(s1.phone_number, "+420724334616");
  });
});

// ── D-E. Switch signal: "тогда меня" → active_subject_id = s1 ────────────

describe("D-E: self-switch signal moves active_subject to s1", () => {
  const stateWithS2: BookingSubjectsState = {
    active_subject_id: "s2",
    subjects: [
      { id: "s1", label: "sender", name: "Рима Астрицкая", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      { id: "s2", label: "mentioned_person", name: "Иван Василенко", service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
    ],
  };

  it("D1: detectSwitchSignal recognises 'тогда меня'", () => {
    assert.equal(detectSwitchSignal("ну тогда меня запишите"), "self");
  });

  it("D2: detectSwitchSignal recognises 'пока меня'", () => {
    assert.equal(detectSwitchSignal("ладно пока меня"), "self");
  });

  it("D3: detectSwitchSignal recognises 'давайте меня'", () => {
    assert.equal(detectSwitchSignal("давайте меня"), "self");
  });

  it("E1: preUpdate with 'тогда меня' switches active_subject to s1", () => {
    const updated = preUpdateBookingSubjects({
      current: stateWithS2,
      userMessage: "тогда меня запишите",
      channelContact: trustedContact,
      providedPhone,
    });
    assert.equal(updated!.active_subject_id, "s1");
  });
});

// ── F. Рима's data is retained after switch ───────────────────────────────

describe("F: s1 data retained when active_subject switches back", () => {
  const stateRimaReady: BookingSubjectsState = {
    active_subject_id: "s2",
    subjects: [
      { id: "s1", label: "sender", name: "Рима Астрицкая", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      { id: "s2", label: "mentioned_person", name: null, service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
    ],
  };

  it("F1: after 'тогда меня', s1.name is still Рима Астрицкая", () => {
    const updated = preUpdateBookingSubjects({
      current: stateRimaReady,
      userMessage: "тогда меня",
      channelContact: trustedContact,
      providedPhone,
    });
    const s1 = subjectById(updated!, "s1")!;
    assert.equal(s1.name, "Рима Астрицкая");
    assert.equal(s1.slot, "2026-07-09T14:00");
    assert.equal(s1.service, "чистка");
  });
});

// ── G-H. Switch back to Иван ──────────────────────────────────────────────

describe("G-H: provided_phone re-appearing keeps active_subject=s2", () => {
  const stateOnS1: BookingSubjectsState = {
    active_subject_id: "s1",
    subjects: [
      { id: "s1", label: "sender", name: "Рима Астрицкая", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      { id: "s2", label: "mentioned_person", name: "Иван Василенко", service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
    ],
  };

  it("H1: when active=s1 and no switch signal → stays s1", () => {
    const updated = preUpdateBookingSubjects({
      current: stateOnS1,
      userMessage: "на 15:00",
      channelContact: trustedContact,
      providedPhone,
    });
    assert.equal(updated!.active_subject_id, "s1");
  });
});

// ── I. Data isolation — subjects don't mix ────────────────────────────────

describe("I: data isolation — s1 and s2 data never mix", () => {
  it("I1: postUpdate with active=s2 only updates s2, s1 unchanged", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s2",
      subjects: [
        { id: "s1", label: "sender", name: "Рима Астрицкая", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
        { id: "s2", label: "mentioned_person", name: null, service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
      ],
    };

    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{
        tool: "booking.apply",
        call_id: "c1",
        arguments: { first_name: "Иван", last_name: "Василенко", requested_date: "2026-07-10", requested_time: "15:00", service: "консультация" },
      }],
      toolResults: [],
    });

    const s1 = subjectById(updated, "s1")!;
    const s2 = subjectById(updated, "s2")!;

    assert.equal(s1.name, "Рима Астрицкая");   // unchanged
    assert.equal(s1.service, "чистка");          // unchanged
    assert.equal(s2.name, "Иван Василенко");     // updated
    assert.equal(s2.service, "консультация");    // updated
    assert.equal(s2.slot, "2026-07-10T15:00");  // updated
  });
});

// ── J. booking.apply uses only active subject ─────────────────────────────

describe("J: postUpdate applies booking.apply to active subject only", () => {
  it("J1: active=s1 → s1 gets name/slot/service, s2 unchanged", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: null, service: null, slot: null, phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Иван", service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
      ],
    };

    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{
        tool: "booking.apply",
        call_id: "c2",
        arguments: { first_name: "Рима", last_name: "Астрицкая", requested_date: "2026-07-09", requested_time: "14:00", service: "чистка" },
      }],
      toolResults: [],
    });

    assert.equal(subjectById(updated, "s1")!.name, "Рима Астрицкая");
    assert.equal(subjectById(updated, "s2")!.name, "Иван");  // untouched
  });
});

// ── K. No booked claim without visit_created ──────────────────────────────

describe("K: status=booked only when visit_created=true in tool result", () => {
  it("K1: visit_created=false → subject stays collecting", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      ],
    };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", call_id: "c3", arguments: { first_name: "Рима", last_name: "Астрицкая", requested_date: "2026-07-09", requested_time: "14:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: false, may_claim_booked: false } }],
    });
    assert.equal(subjectById(updated, "s1")!.status, "collecting");
  });

  it("K2: visit_created=true → active subject becomes booked", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s1",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
      ],
    };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", call_id: "c4", arguments: { first_name: "Рима", last_name: "Астрицкая", requested_date: "2026-07-09", requested_time: "14:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true, may_claim_booked: true, cliniccard_visit_id: "58893937" } }],
    });
    assert.equal(subjectById(updated, "s1")!.status, "booked");
  });

  it("K3: computeReadyForBooking returns false for booked subject", () => {
    const bookedSubject = { id: "s1" as const, label: "sender" as const, name: "Рима", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted" as const, status: "booked" as const };
    assert.equal(computeReadyForBooking(bookedSubject), false);
  });

  it("K4: buildSubjectsContextPayload includes missing and ready_for_booking computed fields", () => {
    const state: BookingSubjectsState = {
      active_subject_id: "s2",
      subjects: [
        { id: "s1", label: "sender", name: "Рима", service: "чистка", slot: "2026-07-09T14:00", phone_number: "+420724334616", phone_status: "trusted", status: "collecting" },
        { id: "s2", label: "mentioned_person", name: "Иван", service: null, slot: null, phone_number: "+420728945521", phone_status: "typed_unverified", status: "collecting" },
      ],
    };
    const payload = buildSubjectsContextPayload(state);
    const subjects = payload.subjects as Array<Record<string, unknown>>;
    const s1 = subjects.find((s) => s.id === "s1")!;
    const s2 = subjects.find((s) => s.id === "s2")!;

    assert.deepEqual(s1.missing, []);
    assert.equal(s1.ready_for_booking, true);
    assert.ok((s2.missing as string[]).includes("slot"));
    assert.ok((s2.missing as string[]).includes("service"));
    assert.equal(s2.ready_for_booking, false);
  });
});

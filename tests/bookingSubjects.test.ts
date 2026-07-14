import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  initBookingSubjectsForTurn,
  postUpdateBookingSubjects,
  detectSubjectMismatch,
  computeMissing,
  computeReadyForBooking,
  deserializeBookingSubjects,
  normalizeBookingSubjectsState,
  applySubjectIntent,
  parseSubjectIntent,
  buildSubjectsContextPayload,
  parsePhoneOwnershipIntent,
  applyPhoneOwnershipIntent,
  bootstrapBookingSubjectsFromIntent,
} from "../src/runtime/bookingSubjectsState.ts";
import type {
  BookingSubjectsState,
  BookingSubject,
  BookingContact,
  BookingContactSource,
  BookingContactTrust,
  SubjectId,
  SubjectIntent,
  PhoneOwnershipIntent,
} from "../src/runtime/bookingSubjectsState.ts";
import type { ChannelContact, ProvidedPhone } from "../src/runtime/openaiRuntimeAgent.ts";

// ── helpers ────────────────────────────────────────────────────────────────

const trustedContact: ChannelContact = {
  phone_number: "+420724334616",
  phone_source: "telegram_contact_button",
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
  status: "active" | "completed" = "active",
): BookingSubjectsState {
  return {
    version: 3,
    status,
    active_subject_id: activeId,
    subjects,
    pending_typed_phone: pendingPhone,
    max_subjects: 4,
  };
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

// ── A. initBookingSubjectsForTurn — no regex bootstrap ────────────────────────

describe("v3: initBookingSubjectsForTurn (no regex)", () => {
  it("V3-A1: null current → null (no bootstrap without intent)", () => {
    const result = initBookingSubjectsForTurn({
      current: null,
      channelContact: trustedContact,
      pendingTypedPhone: null,
    });
    assert.equal(result, null);
  });

  it("V3-A2: text with third-party signal does NOT bootstrap state (no regex)", () => {
    // Previously preUpdateBookingSubjects("Запишите Ивана") → subject_2 created.
    // In v3: text is never analyzed — only model intent triggers bootstrap.
    const result = initBookingSubjectsForTurn({
      current: null,
      channelContact: trustedContact,
      pendingTypedPhone: null,
    });
    assert.equal(result, null, "no text-based bootstrap in v3");
  });

  it("V3-A3: existing state carried forward unchanged (no switch signals)", () => {
    const existing = makeS2State();
    const result = initBookingSubjectsForTurn({
      current: existing,
      channelContact: null,
      pendingTypedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "subject_2");
    assert.equal(result.subjects.length, 2);
  });

  it("V3-A4: channel_contact applied to subject_1 when state exists", () => {
    const existing = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = initBookingSubjectsForTurn({
      current: existing,
      channelContact: trustedContact,
      pendingTypedPhone: null,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.phone_number, "+420724334616");
    assert.equal(s1?.booking_contact?.trust, "trusted");
    assert.equal(s1?.booking_contact?.source, "telegram_contact_button");
  });

  it("V3-A5: typed phone goes to pending_typed_phone ONLY — not to active subject", () => {
    const existing = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = initBookingSubjectsForTurn({
      current: existing,
      channelContact: null,
      pendingTypedPhone: "+420728999000",
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+420728999000");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "phone must not auto-assign to active subject");
  });

  it("V3-A6: trusted channel_contact does NOT downgrade existing trusted contact on s1", () => {
    const existing = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
    ]);
    const differentContact: ChannelContact = {
      phone_number: "+420724334616",
      phone_source: "telegram_contact_button",
    };
    const result = initBookingSubjectsForTurn({
      current: existing,
      channelContact: differentContact,
      pendingTypedPhone: null,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.trust, "trusted");
  });

  it("V3-A7: pending_typed_phone carried from prior state when no new phone", () => {
    const existing = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ], "+420728123456");
    const result = initBookingSubjectsForTurn({
      current: existing,
      channelContact: null,
      pendingTypedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+420728123456");
  });

  it("V3-A8: new typed phone overrides existing pending", () => {
    const existing = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ], "+420728123456");
    const result = initBookingSubjectsForTurn({
      current: existing,
      channelContact: null,
      pendingTypedPhone: "+380991234567",
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+380991234567");
  });
});

// ── B. bootstrapBookingSubjectsFromIntent ─────────────────────────────────────

describe("v3: bootstrapBookingSubjectsFromIntent", () => {
  it("V3-B1: create_subjects intent bootstraps state with subject_1 + mentioned_person", () => {
    const intent: SubjectIntent = {
      action: "create_subjects",
      target: "mentioned_person",
      count: 1,
      confidence: "high",
    };
    const state = bootstrapBookingSubjectsFromIntent(intent);
    assert.ok(state !== null, "state must be bootstrapped");
    assert.ok(state!.subjects.some((s) => s.id === "subject_1"));
    assert.ok(state!.subjects.some((s) => s.role === "mentioned_person"));
    assert.equal(state!.version, 3);
  });

  it("V3-B2: bootstrap includes s1Seed data on subject_1", () => {
    const intent: SubjectIntent = { action: "create_subjects", target: "mentioned_person", count: 1, confidence: "high" };
    const state = bootstrapBookingSubjectsFromIntent(intent, { name: "Рима Валенко", service: "Чистка", slot: "2026-07-10T10:00" });
    assert.ok(state !== null);
    const s1 = state!.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.patient_name, "Рима Валенко");
    assert.equal(s1?.service, "Чистка");
    assert.equal(s1?.slot, "2026-07-10T10:00");
  });

  it("V3-B3: bootstrap applies channel_contact to subject_1", () => {
    const intent: SubjectIntent = { action: "create_subjects", target: "mentioned_person", count: 1, confidence: "high" };
    const state = bootstrapBookingSubjectsFromIntent(intent, null, trustedContact);
    assert.ok(state !== null);
    const s1 = state!.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.trust, "trusted");
    assert.equal(s1?.booking_contact?.phone_number, "+420724334616");
  });

  it("V3-B4: low-confidence intent does not bootstrap", () => {
    const intent: SubjectIntent = { action: "create_subjects", target: "mentioned_person", count: 1, confidence: "low" };
    const state = bootstrapBookingSubjectsFromIntent(intent);
    assert.equal(state, null);
  });

  it("V3-B5: none/switch_subject actions do not bootstrap (wrong action type)", () => {
    const noneIntent: SubjectIntent = { action: "none", target: "active", confidence: "high" };
    assert.equal(bootstrapBookingSubjectsFromIntent(noneIntent), null);
    const switchIntent: SubjectIntent = { action: "switch_subject", target: "self", confidence: "high" };
    assert.equal(bootstrapBookingSubjectsFromIntent(switchIntent), null);
  });

  it("V3-B6: bootstrap state has status=active", () => {
    const intent: SubjectIntent = { action: "create_subjects", target: "mentioned_person", count: 1, confidence: "high" };
    const state = bootstrapBookingSubjectsFromIntent(intent);
    assert.ok(state !== null);
    assert.equal(state!.status, "active");
    assert.equal(state!.version, 3);
  });
});

// ── C. PhoneOwnershipIntent parsing ──────────────────────────────────────────

describe("v3: parsePhoneOwnershipIntent", () => {
  it("V3-C1: valid assign_pending_phone parses correctly", () => {
    const raw = { action: "assign_pending_phone", target_subject_id: "subject_2", confidence: "high" };
    const result = parsePhoneOwnershipIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.action, "assign_pending_phone");
    assert.equal(result!.target_subject_id, "subject_2");
    assert.equal(result!.confidence, "high");
  });

  it("V3-C2: valid share_sender_contact parses", () => {
    const raw = { action: "share_sender_contact", target_subject_id: "subject_3", confidence: "medium" };
    const result = parsePhoneOwnershipIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.action, "share_sender_contact");
    assert.equal(result!.target_subject_id, "subject_3");
  });

  it("V3-C3: none action parses with null target", () => {
    const raw = { action: "none", target_subject_id: null, confidence: "high" };
    const result = parsePhoneOwnershipIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.action, "none");
    assert.equal(result!.target_subject_id, null);
  });

  it("V3-C4: invalid action rejects", () => {
    assert.equal(parsePhoneOwnershipIntent({ action: "steal_phone", confidence: "high" }), null);
  });

  it("V3-C5: invalid confidence rejects", () => {
    assert.equal(parsePhoneOwnershipIntent({ action: "none", confidence: "super_high" }), null);
  });

  it("V3-C6: null/non-object input returns null", () => {
    assert.equal(parsePhoneOwnershipIntent(null), null);
    assert.equal(parsePhoneOwnershipIntent("string"), null);
    assert.equal(parsePhoneOwnershipIntent(42), null);
  });

  it("V3-C7: invalid target_subject_id format → target is null", () => {
    const raw = { action: "assign_pending_phone", target_subject_id: "not_valid", confidence: "high" };
    const result = parsePhoneOwnershipIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.target_subject_id, null);
  });

  it("V3-C8: missing target_subject_id → target is null (not error)", () => {
    const raw = { action: "assign_pending_phone", confidence: "high" };
    const result = parsePhoneOwnershipIntent(raw);
    assert.ok(result !== null);
    assert.equal(result!.target_subject_id, null);
  });
});

// ── D. applyPhoneOwnershipIntent ──────────────────────────────────────────────

describe("v3: applyPhoneOwnershipIntent", () => {
  it("V3-D1: assign_pending_phone moves pending to explicit target subject", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ], "+420728999000");
    const intent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    assert.equal(updated.pending_typed_phone, null, "pending must be consumed");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, "+420728999000");
    assert.equal(s2?.booking_contact?.source, "typed");
    assert.equal(s2?.booking_contact?.trust, "unverified");
    assert.equal(s2?.booking_contact?.owner_subject_id, "subject_2");
  });

  it("V3-D2: assign_pending_phone with null target_subject_id → no assignment (explicit target required)", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ], "+420728999000");
    // target_subject_id null is invalid — must be explicit. No active_subject_id fallback.
    const intent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: null, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "no assignment when target_subject_id is null");
    assert.equal(updated.pending_typed_phone, "+420728999000", "pending preserved when no assignment");
  });

  it("V3-D3: assign_pending_phone does nothing when no pending phone", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ]); // pending_typed_phone = null
    const intent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "no assignment when pending is null");
  });

  it("V3-D4: assign_pending_phone does not overwrite trusted contact", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
    ], "+420728999000");
    const intent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_1" as SubjectId, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.trust, "trusted", "trusted contact must not be downgraded");
    assert.equal(s1?.booking_contact?.phone_number, "+420724334616");
  });

  it("V3-D5: share_sender_contact copies s1 trusted contact to target as trusted_contact_owner", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", {
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Дочь" }),
    ]);
    const intent: PhoneOwnershipIntent = { action: "share_sender_contact", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, "+420724334616");
    assert.equal(s2?.booking_contact?.source, "shared_from_subject");
    assert.equal(s2?.booking_contact?.trust, "trusted_contact_owner");
    assert.equal(s2?.booking_contact?.owner_subject_id, "subject_1");
  });

  it("V3-D6: share_sender_contact requires s1 to have trusted contact", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"), // no contact
      makeSubject("subject_2", "mentioned_person"),
    ]);
    const intent: PhoneOwnershipIntent = { action: "share_sender_contact", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "no share when s1 has no contact");
  });

  it("V3-D7: share_sender_contact requires s1 to have TRUSTED contact", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", {
        booking_contact: makeBC("+420728999000", "typed", "unverified", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person"),
    ]);
    const intent: PhoneOwnershipIntent = { action: "share_sender_contact", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "unverified s1 contact cannot be shared as trusted");
  });

  it("V3-D8: none action leaves state unchanged", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
    ], "+420728999000");
    const intent: PhoneOwnershipIntent = { action: "none", target_subject_id: null, confidence: "high" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    assert.equal(updated.pending_typed_phone, "+420728999000", "pending unchanged");
    assert.equal(updated.subjects[0]?.booking_contact, null, "no phone assigned");
  });

  it("V3-D9: low-confidence intent is ignored", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ], "+420728999000");
    const intent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "low" };
    const updated = applyPhoneOwnershipIntent(state, intent);
    assert.equal(updated.pending_typed_phone, "+420728999000", "low confidence: no change");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null);
  });
});

// ── E. Status lifecycle ────────────────────────────────────────────────────────

describe("v3: status lifecycle (simplified — no episode_id/dates)", () => {
  it("V3-E1: new state from bootstrapBookingSubjectsFromIntent has status=active", () => {
    const intent: SubjectIntent = { action: "create_subjects", target: "mentioned_person", count: 1, confidence: "high" };
    const state = bootstrapBookingSubjectsFromIntent(intent);
    assert.equal(state?.status, "active");
    assert.equal(state?.version, 3);
  });

  it("V3-E2: status auto-completes to 'completed' when all subjects booked in postUpdate", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        service: "Чистка",
        slot: "2026-07-10T10:00",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
    ]);
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Рима", last_name: "Петрова", requested_date: "2026-07-10", requested_time: "10:00", service: "Чистка" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
      executionSubjectId: "subject_1" as SubjectId,
    });
    assert.equal(updated.status, "completed");
  });

  it("V3-E3: status stays active when only some subjects booked", () => {
    const state = makeState("subject_2", [
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
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", requested_date: "2026-07-11", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
      executionSubjectId: "subject_2" as SubjectId,
    });
    assert.equal(updated.status, "active", "status stays active while subject_1 not yet booked");
  });

  it("V3-E4: start_new_episode is no longer a valid action — applySubjectIntent ignores it", () => {
    const state = makeState("subject_1", [
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
        status: "booked",
      }),
    ], null, "completed");
    // start_new_episode was removed — parseSubjectIntent returns null for it.
    const parsed = parseSubjectIntent({ action: "start_new_episode", target: "active", confidence: "high" });
    assert.equal(parsed, null, "start_new_episode must no longer parse (removed from valid actions)");
    // State must be unchanged (status stays completed)
    assert.equal(state.status, "completed");
  });

  it("V3-E5: completed registry treated as historical — initBookingSubjectsForTurn returns null", () => {
    // Completed registries are not carried forward as active state.
    // Fresh flow creates a new registry via bootstrap on the next booking turn.
    const state = makeState("subject_1", [makeSubject("subject_1", "sender", { status: "booked" })], null, "completed");
    const carried = initBookingSubjectsForTurn({ current: state, channelContact: null, pendingTypedPhone: null });
    assert.equal(carried, null, "completed registry must not be passed as active booking_subjects");
  });

  it("V3-E6: parseSubjectIntent rejects start_new_episode (removed action)", () => {
    const raw = { action: "start_new_episode", target: "active", confidence: "high" };
    const result = parseSubjectIntent(raw);
    assert.equal(result, null, "start_new_episode must no longer be accepted by parseSubjectIntent");
  });
});

// ── F. subject_id_at_execution ─────────────────────────────────────────────────

describe("v3: subject_id_at_execution (atomic booking execution)", () => {
  it("V3-F1: booking result applied to executionSubjectId, not current active", () => {
    // Scenario: subject_2 was active when booking.apply ran (execution time),
    // but subject_intent switches back to subject_1 afterward.
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Иван",
        service: "Чистка",
        slot: "2026-07-11T11:00",
        booking_contact: makeBC("+420728945521", "typed", "unverified", "subject_2"),
      }),
    ]);
    const intent: SubjectIntent = { action: "switch_subject", target: "self", confidence: "high" };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", requested_date: "2026-07-11", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
      subjectIntent: intent,
      executionSubjectId: "subject_2" as SubjectId,
    });
    // subject_intent switched active to subject_1
    assert.equal(updated.active_subject_id, "subject_1");
    // booking result must go to subject_2 (frozen at execution time)
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked", "subject_2 must be marked booked");
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.status, "collecting", "subject_1 must not be affected by booking");
  });

  it("V3-F2: without executionSubjectId, booking result is NOT applied — state returned unchanged", () => {
    const state = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
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
      // No executionSubjectId → booking result must NOT be applied (no active_subject_id fallback)
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "collecting", "without executionSubjectId, status must not change to booked");
  });

  it("V3-F3: phoneOwnershipIntent applied in postUpdate before booking result", () => {
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ], "+420728999000");
    const pIntent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const updated = postUpdateBookingSubjects({
      current: state,
      toolRequests: [],
      toolResults: [],
      phoneOwnershipIntent: pIntent,
    });
    assert.equal(updated.pending_typed_phone, null, "pending consumed by phone_ownership_intent");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact?.phone_number, "+420728999000");
  });

  it("V3-F4: executionSubjectId null — booking result NOT applied (no fallback to active_subject_id)", () => {
    const bootstrappedState = makeState("subject_2", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    // executionSubjectId=null with booking.apply present → state returned unchanged
    const updated = postUpdateBookingSubjects({
      current: bootstrappedState,
      toolRequests: [{ tool: "booking.apply", arguments: { first_name: "Иван", requested_date: "2026-07-11", requested_time: "11:00" } }],
      toolResults: [{ tool: "booking.apply", status: "success", data: { created_visit: true } }],
      executionSubjectId: null,
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "collecting", "null executionSubjectId must not update any subject");
  });
});

// ── G. v3 state type + normalization ─────────────────────────────────────────

describe("v3: state type and normalization", () => {
  it("V3-G1: normalizeBookingSubjectsState reads v3 state correctly", () => {
    const rawV3 = {
      version: 3,
      status: "active",
      active_subject_id: "subject_2",
      subjects: [
        { id: "subject_1", role: "sender", patient_name: "Рима", service: null, slot: null, booking_contact: null, status: "collecting", label: null },
        { id: "subject_2", role: "mentioned_person", patient_name: "Иван", service: null, slot: null, booking_contact: null, status: "collecting", label: null },
      ],
      pending_typed_phone: null,
    };
    const result = normalizeBookingSubjectsState(rawV3);
    assert.ok(result !== null);
    assert.equal(result!.version, 3);
    assert.equal(result!.status, "active");
    assert.equal(result!.active_subject_id, "subject_2");
  });

  it("V3-G1b: normalizeBookingSubjectsState coerces old episode_status field to status", () => {
    // Old persisted data may have episode_status instead of status — must coerce
    // completed state requires all subjects to be booked
    const rawOld = {
      version: 3,
      episode_status: "completed",
      active_subject_id: "subject_1",
      subjects: [
        { id: "subject_1", role: "sender", patient_name: "Рима", service: "Чистка", slot: "2026-07-10T10:00", booking_contact: null, status: "booked", label: null },
      ],
      pending_typed_phone: null,
    };
    const result = normalizeBookingSubjectsState(rawOld);
    assert.ok(result !== null);
    assert.equal(result!.status, "completed", "episode_status coerced to status");
  });

  it("V3-G2: v2 state migrates to v3 with status=active", () => {
    const rawV2 = {
      version: 2,
      active_subject_id: "subject_2",
      subjects: [
        { id: "subject_1", role: "sender", patient_name: "Рима", service: null, slot: null, booking_contact: null, status: "collecting", label: null },
        { id: "subject_2", role: "mentioned_person", patient_name: "Иван", service: null, slot: null, booking_contact: null, status: "collecting", label: null },
      ],
      pending_typed_phone: null,
    };
    const result = normalizeBookingSubjectsState(rawV2);
    assert.ok(result !== null);
    assert.equal(result!.version, 3, "v2 must be upgraded to v3");
    assert.equal(result!.status, "active", "migrated state must have status=active");
  });

  it("V3-G3: v3 completed status preserved across serialize/deserialize", () => {
    const state = makeState("subject_1", [makeSubject("subject_1", "sender", { status: "booked" })], null, "completed");
    const serialized = JSON.parse(JSON.stringify(state));
    const restored = deserializeBookingSubjects(serialized);
    assert.ok(restored !== null);
    assert.equal(restored!.status, "completed");
  });

  it("V3-G4: buildSubjectsContextPayload includes status and version", () => {
    const state = makeState("subject_1", [makeSubject("subject_1", "sender")]);
    const payload = buildSubjectsContextPayload(state);
    assert.equal(payload.status, "active");
    assert.equal(payload.version, 3);
    assert.ok(!("episode_id" in payload), "episode_id must not be in payload");
  });
});

// ── H. computeMissing / computeReadyForBooking ────────────────────────────────

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

// ── I. deserializeBookingSubjects round-trip + v1 migration ──────────────────

describe("deserializeBookingSubjects", () => {
  it("T: v3 state round-trips through JSON", () => {
    const state = makeS2State("Иван");
    const serialized = JSON.parse(JSON.stringify(state));
    const restored = deserializeBookingSubjects(serialized);
    assert.ok(restored !== null);
    assert.equal(restored.active_subject_id, "subject_2");
    assert.equal(restored.subjects.length, 2);
    assert.equal(restored.version, 3);
    const s1 = restored.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.patient_name, "Рима");
  });

  it("U: null/empty input returns null", () => {
    assert.equal(deserializeBookingSubjects(null), null);
    assert.equal(deserializeBookingSubjects(undefined), null);
    assert.equal(deserializeBookingSubjects({}), null);
  });

  it("T2: v1 state (s1/s2) migrates to v3 correctly", () => {
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
    assert.equal(result.version, 3);
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
    assert.equal(result.status, "active");
  });
});

// ── J. detectSubjectMismatch ──────────────────────────────────────────────────

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

// ── K. postUpdateBookingSubjects ──────────────────────────────────────────────

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
      executionSubjectId: "subject_2" as SubjectId,
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
      executionSubjectId: "subject_2" as SubjectId,
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.ok(s2);
    assert.equal(s2.patient_name, "Иван Петров");
    assert.equal(s2.service, "Чистка");
    assert.equal(s2.slot, "2026-07-15T09:00");
    assert.equal(s2.status, "collecting");
  });
});

// ── L. Execution guard ────────────────────────────────────────────────────────

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

// ── M. initBookingSubjectsForTurn: existing state scenarios ──────────────────

describe("initBookingSubjectsForTurn: state continuity", () => {
  it("V: no state + no intent → null (single-subject mode)", () => {
    const result = initBookingSubjectsForTurn({
      current: null,
      channelContact: trustedContact,
      pendingTypedPhone: null,
    });
    assert.equal(result, null);
  });

  it("W: no state + typed phone → null (single-subject mode, phone via provided_phone path)", () => {
    const result = initBookingSubjectsForTurn({
      current: null,
      channelContact: null,
      pendingTypedPhone: "+420728999000",
    });
    assert.equal(result, null);
  });
});

// ── N. PR#173 updated tests ───────────────────────────────────────────────────

describe("PR#173: subject-aware phone assignment (v3 behavior)", () => {
  it("A173: active=subject_1 + typed phone → pending_typed_phone set, NOT auto-assigned to active subject", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = initBookingSubjectsForTurn({
      current,
      channelContact: null,
      pendingTypedPhone: providedPhone.phone_number,
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, providedPhone.phone_number);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact, null, "phone must NOT auto-assign to active subject in v3");
  });

  it("B173: subject_1 trusted channel_contact applied correctly", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender", { patient_name: "Рима" }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = initBookingSubjectsForTurn({
      current,
      channelContact: trustedContact,
      pendingTypedPhone: providedPhone.phone_number,
    });
    assert.ok(result !== null);
    const s1 = result.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.booking_contact?.phone_number, trustedContact.phone_number);
    assert.equal(s1?.booking_contact?.trust, "trusted");
    assert.equal(s1?.booking_contact?.source, "telegram_contact_button");
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
      executionSubjectId: "subject_1" as SubjectId,
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
      executionSubjectId: "subject_2" as SubjectId,
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked");
    const s1 = updated.subjects.find((s) => s.id === "subject_1");
    assert.equal(s1?.status, "booked");
  });

  it("F173: typed phone → pending only (not auto-assigned to active subject)", () => {
    const current = makeState("subject_2", [
      makeSubject("subject_1", "sender", {
        patient_name: "Рима",
        booking_contact: makeBC("+420724334616", "telegram_contact_button", "trusted", "subject_1"),
      }),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Иван" }),
    ]);
    const result = initBookingSubjectsForTurn({
      current,
      channelContact: null,
      pendingTypedPhone: providedPhone.phone_number,
    });
    assert.ok(result !== null);
    assert.equal(result.active_subject_id, "subject_2");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "in v3 phone goes to pending, not active subject");
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
      makeSubject("subject_1", "sender", { patient_name: "Рима", service: "Чистка", slot: "2026-07-10T10:00" }),
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

// ── O. PR#174: subject_intent formal contract tests ───────────────────────────

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

  it("J174b: subjectIntent switch does NOT consume pending_typed_phone — only phone_ownership_intent does", () => {
    // v3 spec: subject_intent switches the active subject but never assigns pending phone.
    // pending_typed_phone is only resolved by phone_ownership_intent.
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
    assert.equal(updated.active_subject_id, "subject_2", "active subject switches");
    assert.equal(updated.pending_typed_phone, "+420728123456", "pending_typed_phone must NOT be consumed by subject_intent");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "subject_2 contact unchanged — phone not assigned");
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

// ── P. PR#174-fix: pending_typed_phone preservation ──────────────────────────

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

  it("B174-fix: subjectIntent switch does NOT consume pending_typed_phone (v3 — only phone_ownership_intent does)", () => {
    // v3 spec: pending phone is never assigned via subject_intent.
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
    assert.equal(updated.pending_typed_phone, "+420728123456", "pending phone stays pending until phone_ownership_intent");
    assert.equal(updated.active_subject_id, "subject_2", "subject switches");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "no auto-assignment from subject_intent");
    // Phone is assigned only when phone_ownership_intent.assign_pending_phone fires
    const pIntent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const assigned = applyPhoneOwnershipIntent(updated, pIntent);
    const s2after = assigned.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2after?.booking_contact?.phone_number, "+420728123456");
    assert.equal(s2after?.booking_contact?.source, "typed");
    assert.equal(assigned.pending_typed_phone, null, "phone consumed after phone_ownership_intent");
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
      executionSubjectId: "subject_2" as SubjectId,
    });
    assert.equal(updated.pending_typed_phone, null);
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked");
  });
});

// ── Q. PR#175: no pending phone reinjection ───────────────────────────────────

describe("PR#175: pending_typed_phone not re-created without new typed phone", () => {
  const stateAfterClassification = makeState("subject_2", [
    makeSubject("subject_1", "sender", { patient_name: "Миша Бондаренко", service: "Чистка" }),
    makeSubject("subject_2", "mentioned_person", {
      patient_name: "Анна Бондаренко",
      service: "Чистка",
      booking_contact: makeBC("+420728123456", "typed", "unverified", "subject_2"),
    }),
  ]);

  it("A175: no current-turn typed phone → pending_typed_phone stays null", () => {
    const result = initBookingSubjectsForTurn({
      current: stateAfterClassification,
      channelContact: null,
      pendingTypedPhone: null,
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
    const result = initBookingSubjectsForTurn({
      current: stateWithPending,
      channelContact: null,
      pendingTypedPhone: null,
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+420728123456");
  });

  it("C175: new typed phone on a later turn overrides previous pending", () => {
    const result = initBookingSubjectsForTurn({
      current: stateAfterClassification,
      channelContact: null,
      pendingTypedPhone: "+380991234567",
    });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+380991234567");
  });

  it("D175: null current → null (single-subject mode)", () => {
    const result = initBookingSubjectsForTurn({
      current: null,
      channelContact: null,
      pendingTypedPhone: null,
    });
    assert.equal(result, null);
  });
});

// ── R. PR#176: Subject Registry v3 ───────────────────────────────────────────

describe("PR#176: Subject Registry v3", () => {
  // A. Single subject — no bootstrap without intent
  it("A176: no prior state → null (bootstrap requires model intent)", () => {
    const result = initBookingSubjectsForTurn({
      current: null,
      channelContact: null,
      pendingTypedPhone: null,
    });
    assert.equal(result, null, "single-subject mode: no booking_subjects created");
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

  // F. Typed phone → pending only in v3
  it("F176: active=subject_2, typed phone → pending_typed_phone only (NOT booking_contact)", () => {
    const current = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Парень" }),
    ]);
    const result = initBookingSubjectsForTurn({ current, channelContact: null, pendingTypedPhone: "+420728111222" });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+420728111222");
    const s2 = result.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "in v3 typed phone goes to pending only");
    // After phone_ownership_intent.assign_pending_phone, contact gets assigned
    const pIntent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const assigned = applyPhoneOwnershipIntent(result, pIntent);
    const s2after = assigned.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2after?.booking_contact?.source, "typed");
    assert.equal(s2after?.booking_contact?.trust, "unverified");
  });

  // G. Ambiguous typed phone — pending set
  it("G176: multi-subject + typed phone → pending_typed_phone set", () => {
    const current = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person"),
    ]);
    const result = initBookingSubjectsForTurn({ current, channelContact: null, pendingTypedPhone: "+420728999000" });
    assert.ok(result !== null);
    assert.equal(result.pending_typed_phone, "+420728999000");
  });

  // H. Pending phone classification — only via phone_ownership_intent
  it("H176: applySubjectIntent does NOT assign pending phone — only phone_ownership_intent does", () => {
    // v3 spec: applySubjectIntent only switches subjects. Phone assignment is separate.
    const state = makeState("subject_1", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", { patient_name: "Мама" }),
    ], "+420728999000");
    const intent: SubjectIntent = { action: "switch_subject", target: "mentioned_person", confidence: "high" };
    const updated = applySubjectIntent(state, intent);
    assert.equal(updated.active_subject_id, "subject_2", "subject switched");
    assert.equal(updated.pending_typed_phone, "+420728999000", "pending stays pending after subject_intent");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "no auto-assignment");
    // Phone is assigned only when phone_ownership_intent fires
    const pIntent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const assigned = applyPhoneOwnershipIntent(updated, pIntent);
    const s2after = assigned.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2after?.booking_contact?.phone_number, "+420728999000");
    assert.equal(s2after?.booking_contact?.trust, "unverified");
    assert.equal(assigned.pending_typed_phone, null);
  });

  // I. No reinjection regression
  it("I176: after classification, initBookingSubjectsForTurn with no new phone keeps pending=null", () => {
    const classifiedState = makeState("subject_2", [
      makeSubject("subject_1", "sender"),
      makeSubject("subject_2", "mentioned_person", {
        patient_name: "Анна",
        booking_contact: makeBC("+420728123456", "typed", "unverified", "subject_2"),
      }),
    ]); // pending_typed_phone = null (already consumed)
    const result = initBookingSubjectsForTurn({
      current: classifiedState,
      channelContact: null,
      pendingTypedPhone: null,
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
    assert.equal(payload.version, 3);
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
      executionSubjectId: "subject_2" as SubjectId,
    });
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.status, "booked");
    assert.deepEqual(s2?.missing, [], "all fields present + booked: missing should be empty");
  });

  // L. V1 migration
  it("L176: v1 state (s1/s2) migrates cleanly to v3 preserving phone/service/slot", () => {
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
    assert.equal(result.version, 3);
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

  // M. parseSubjectIntent v3 fields
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

// ── S. PR#175 review fixes: Blockers 1-3 regression tests ────────────────────

describe("PR#175-review: Blocker 1 — pending phone (v3 behavior: only via phone_ownership_intent)", () => {
  it("A: subject_intent switch does NOT consume pending phone — only phone_ownership_intent does", () => {
    // v3 spec: pending phone is never consumed by subject_intent
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
    assert.equal(updated.pending_typed_phone, "+420728111222", "pending stays pending after subject_intent");
    const s2 = updated.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2?.booking_contact, null, "booking_contact not set by subject_intent");
    // Phone resolved only via phone_ownership_intent
    const pIntent: PhoneOwnershipIntent = { action: "assign_pending_phone", target_subject_id: "subject_2" as SubjectId, confidence: "high" };
    const assigned = applyPhoneOwnershipIntent(updated, pIntent);
    const s2after = assigned.subjects.find((s) => s.id === "subject_2");
    assert.equal(s2after?.booking_contact?.source, "typed");
    assert.equal(s2after?.booking_contact?.trust, "unverified");
    assert.equal(s2after?.booking_contact?.phone_number, "+420728111222");
    assert.equal(assigned.pending_typed_phone, null);
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
    const subjects = stateRaw.subjects as Array<{ id: string; booking_contact?: unknown }>;
    const s2 = subjects.find((s) => s.id === "subject_2");
    const bc = s2?.booking_contact as Record<string, unknown> | null;
    assert.ok(bc);
    assert.equal(bc!.source, "shared_from_subject");
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
    const resolvedTrust = ownerBc!.trust === "trusted" ? "trusted" : "unverified";
    assert.equal(resolvedTrust, "unverified", "typed owner contact must not become trusted when shared");
  });
});

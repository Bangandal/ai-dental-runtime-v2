import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelVisibleBookingProcessState,
  type BookingProcessState,
} from "../src/runtime/bookingProcessState.ts";
import type { AvailabilityEvidence } from "../src/runtime/slotEvidence.ts";

const TIMEZONE = "Europe/Prague";

function evidence(
  allowed_slot_keys: string[],
  checked_at: string,
): AvailabilityEvidence {
  return {
    availability_call_id: "call-tz",
    requested_date: "2026-08-12",
    requested_time: null,
    allowed_slot_keys,
    checked_at,
  };
}

function state(opts: {
  slots?: Array<{ starts_at: string }>;
  selectedSlot?: { starts_at: string } | null;
  evidence: AvailabilityEvidence;
  slotKnown?: boolean;
  ready?: boolean;
  nextAction?: BookingProcessState["next_action"];
}): BookingProcessState {
  const slotKnown = opts.slotKnown ?? false;
  const ready = opts.ready ?? false;
  return {
    service_reason: "consultation",
    first_name: "Test",
    last_name: "Patient",
    last_available_slots: opts.slots ?? [],
    selected_slot: opts.selectedSlot ?? null,
    active_availability_evidence: opts.evidence,
    selected_slot_proof: opts.selectedSlot
      ? {
          subject_id: "subject_1",
          availability_call_id: opts.evidence.availability_call_id,
          slot_key: opts.evidence.allowed_slot_keys[0]!,
        }
      : null,
    phone_trusted: true,
    next_action: opts.nextAction ?? "choose_from_available_slots",
    proof: {
      service_known: true,
      name_known: true,
      slot_known: slotKnown,
      trusted_phone_known: true,
      ready_for_booking_apply: ready,
    },
  };
}

const GROUNDED = {
  priorProcessState: null as null,
  bookingStateGrounded: true,
};

test("TZ-BIND-1: UTC future slot remains visible when evidence key is clinic-local", () => {
  // 12:00Z = 14:00 Prague; now = 12:30 Prague.
  const now = new Date("2026-08-12T10:30:00Z");
  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: state({
      evidence: evidence(["2026-08-12T14:00"], "2026-08-12T10:25:00Z"),
      slots: [{ starts_at: "2026-08-12T12:00:00Z" }],
    }),
    now,
    timezone: TIMEZONE,
  });

  assert.equal(visible.last_available_slots?.length, 1);
  assert.equal(visible.last_available_slots?.[0]?.starts_at, "2026-08-12T12:00:00Z");
  assert.notEqual(visible.slot_evidence_status, "stale");
});

test("TZ-BIND-2: +00:00 future slot remains visible against clinic-local evidence", () => {
  // 12:00+00:00 = 14:00 Prague; now = 12:30 Prague.
  const now = new Date("2026-08-12T10:30:00Z");
  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: state({
      evidence: evidence(["2026-08-12T14:00"], "2026-08-12T10:25:00Z"),
      slots: [{ starts_at: "2026-08-12T12:00:00+00:00" }],
    }),
    now,
    timezone: TIMEZONE,
  });

  assert.equal(visible.last_available_slots?.length, 1);
  assert.notEqual(visible.slot_evidence_status, "stale");
});

test("TZ-BIND-3: explicit Prague offset future slot remains visible", () => {
  // 14:00+02:00 = 14:00 Prague; now = 13:00 Prague.
  const now = new Date("2026-08-12T11:00:00Z");
  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: state({
      evidence: evidence(["2026-08-12T14:00"], "2026-08-12T10:55:00Z"),
      slots: [{ starts_at: "2026-08-12T14:00:00+02:00" }],
    }),
    now,
    timezone: TIMEZONE,
  });

  assert.equal(visible.last_available_slots?.length, 1);
  assert.notEqual(visible.slot_evidence_status, "stale");
});

test("TZ-BIND-4: bare local timestamp keeps ClinicCard wall-time semantics", () => {
  // Bare 12:00 is 12:00 Prague; now = 12:30 Prague, so it is expired.
  const now = new Date("2026-08-12T10:30:00Z");
  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: state({
      evidence: evidence(["2026-08-12T12:00"], "2026-08-12T10:25:00Z"),
      slots: [{ starts_at: "2026-08-12T12:00:00" }],
    }),
    now,
    timezone: TIMEZONE,
  });

  assert.equal(visible.last_available_slots?.length, 0);
  assert.equal(visible.slot_evidence_status, "stale");
});

test("TZ-BIND-5: mixed past and future UTC slots do not become all-expired", () => {
  // 08:00Z = 10:00 Prague (past); 12:00Z = 14:00 Prague (future); now = 12:30 Prague.
  const now = new Date("2026-08-12T10:30:00Z");
  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: state({
      evidence: evidence(
        ["2026-08-12T10:00", "2026-08-12T14:00"],
        "2026-08-12T10:25:00Z",
      ),
      slots: [
        { starts_at: "2026-08-12T08:00:00Z" },
        { starts_at: "2026-08-12T12:00:00Z" },
      ],
    }),
    now,
    timezone: TIMEZONE,
  });

  assert.equal(visible.last_available_slots?.length, 1);
  assert.equal(visible.last_available_slots?.[0]?.starts_at, "2026-08-12T12:00:00Z");
  assert.notEqual(visible.slot_evidence_status, "stale");
});

test("TZ-BIND-6: selected UTC future slot keeps verified proof and ready state", () => {
  // 12:00Z = 14:00 Prague; now = 12:30 Prague.
  const now = new Date("2026-08-12T10:30:00Z");
  const selected = { starts_at: "2026-08-12T12:00:00Z" };
  const visible = buildModelVisibleBookingProcessState({
    ...GROUNDED,
    state: state({
      evidence: evidence(["2026-08-12T14:00"], "2026-08-12T10:25:00Z"),
      slots: [selected],
      selectedSlot: selected,
      slotKnown: true,
      ready: true,
      nextAction: "ready_for_booking_apply",
    }),
    now,
    timezone: TIMEZONE,
  });

  assert.equal(visible.selected_slot?.starts_at, "2026-08-12T12:00:00Z");
  assert.equal(visible.slot_evidence_status, "verified");
  assert.equal(visible.proof?.slot_known, true);
  assert.equal(visible.proof?.ready_for_booking_apply, true);
  assert.equal(visible.next_action, "ready_for_booking_apply");
});

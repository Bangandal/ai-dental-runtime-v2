import test from "node:test";
import assert from "node:assert/strict";

import {
  canDeriveAgentFirstBookingSelectionFromPriorEvidence,
  deriveAgentFirstBookingSelection,
} from "../src/runtime/agentFirstBookingSlotBinding.ts";
import type { BookingProcessState } from "../src/runtime/bookingProcessState.ts";
import type { BookingSubject } from "../src/runtime/bookingSubjectsState.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

function withAgentFirst<T>(fn: () => T): T {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = "agent_first";
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
}

function bookingApply(time = "15:00"): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: "book_1",
    arguments: {
      requested_date: "2026-08-24",
      requested_time: time,
      first_name: "Ivan",
      last_name: "Petrov",
      service: "cleaning",
    },
  };
}

function state(checkedAt: string): BookingProcessState {
  return {
    selected_slot: null,
    selected_slot_proof: null,
    active_availability_evidence: {
      availability_call_id: "avail_1",
      requested_date: "2026-08-24",
      requested_time: null,
      allowed_slot_keys: ["2026-08-24T15:00", "2026-08-24T15:30"],
      checked_at: checkedAt,
    },
    proof: {
      service_known: true,
      name_known: true,
      slot_known: false,
      trusted_phone_known: true,
      ready_for_booking_apply: false,
    },
  };
}

function subject(id: "subject_1" | "subject_2"): BookingSubject {
  return {
    id,
    role: id === "subject_1" ? "sender" : "mentioned_person",
    label: id === "subject_1" ? "self" : "daughter",
    patient_name: "Ivan Petrov",
    service: "cleaning",
    slot: "2026-08-24T15:00",
    booking_contact: null,
    status: "collecting",
    missing: [],
  };
}

test("agent-first derives the old slot proof from fresh exact prior evidence", () => {
  withAgentFirst(() => {
    const result = deriveAgentFirstBookingSelection({
      booking_apply: bookingApply("15:00"),
      execution_subject_id: "subject_1",
      booking_process_state: state("2026-08-22T10:00:00.000Z"),
      subjects: [subject("subject_1")],
      now: new Date("2026-08-22T10:05:00.000Z"),
    });

    assert.deepEqual(result, {
      selection_status: "selected",
      subject_id: "subject_1",
      selected_slot_key: "2026-08-24T15:00",
      may_apply_booking: true,
    });
  });
});

test("agent-first refuses stale availability evidence", () => {
  withAgentFirst(() => {
    const result = deriveAgentFirstBookingSelection({
      booking_apply: bookingApply("15:00"),
      execution_subject_id: "subject_1",
      booking_process_state: state("2026-08-22T09:40:00.000Z"),
      subjects: [subject("subject_1")],
      now: new Date("2026-08-22T10:00:00.000Z"),
    });

    assert.equal(result, null);
  });
});

test("agent-first refuses a slot that was not in authoritative availability", () => {
  withAgentFirst(() => {
    const result = deriveAgentFirstBookingSelection({
      booking_apply: bookingApply("16:00"),
      execution_subject_id: "subject_1",
      booking_process_state: state("2026-08-22T10:00:00.000Z"),
      subjects: [subject("subject_1")],
      now: new Date("2026-08-22T10:05:00.000Z"),
    });

    assert.equal(result, null);
  });
});

test("agent-first refuses proof creation for an execution subject outside the registry", () => {
  withAgentFirst(() => {
    const result = deriveAgentFirstBookingSelection({
      booking_apply: bookingApply("15:00"),
      execution_subject_id: "subject_2",
      booking_process_state: state("2026-08-22T10:00:00.000Z"),
      subjects: [subject("subject_1")],
      now: new Date("2026-08-22T10:05:00.000Z"),
    });

    assert.equal(result, null);
  });
});

test("legacy mode never derives the slot proof implicitly", () => {
  const previous = process.env.RUNTIME_AGENT_MODE;
  process.env.RUNTIME_AGENT_MODE = "legacy";
  try {
    const result = deriveAgentFirstBookingSelection({
      booking_apply: bookingApply("15:00"),
      execution_subject_id: "subject_1",
      booking_process_state: state("2026-08-22T10:00:00.000Z"),
      subjects: [subject("subject_1")],
      now: new Date("2026-08-22T10:05:00.000Z"),
    });

    assert.equal(result, null);
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previous;
  }
});

test("availability.check and booking.apply in the same batch cannot self-authorize", () => {
  assert.equal(
    canDeriveAgentFirstBookingSelectionFromPriorEvidence([
      {
        tool: "availability.check",
        call_id: "avail_2",
        arguments: { requested_date: "2026-08-24" },
      },
      bookingApply("15:00"),
    ]),
    false,
  );

  assert.equal(
    canDeriveAgentFirstBookingSelectionFromPriorEvidence([bookingApply("15:00")]),
    true,
  );
});

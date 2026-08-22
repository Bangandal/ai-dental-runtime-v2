import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { postUpdateBookingSubjects } from "../src/runtime/bookingSubjectsState.ts";
import type { BookingSubjectsState, SubjectId } from "../src/runtime/bookingSubjectsState.ts";
import type { RuntimeAgentToolRequest, RuntimeAgentToolResult } from "../src/runtime/openaiRuntimeAgent.ts";

function makeState(): BookingSubjectsState {
  return {
    version: 3,
    status: "active",
    active_subject_id: "subject_1" as SubjectId,
    pending_typed_phone: null,
    max_subjects: 4,
    subjects: [
      {
        id: "subject_1" as SubjectId,
        role: "sender",
        label: null,
        patient_name: "Sender Person",
        service: null,
        slot: null,
        booking_contact: null,
        status: "collecting",
        missing: ["slot", "service", "booking_contact"],
      },
      {
        id: "subject_2" as SubjectId,
        role: "mentioned_person",
        label: null,
        patient_name: null,
        service: null,
        slot: null,
        booking_contact: null,
        status: "collecting",
        missing: ["patient_name", "slot", "service", "booking_contact"],
      },
    ],
  };
}

test("R3i: frozen booking_apply_resolution preserves blocked-request facts on the resolved patient", () => {
  const request: RuntimeAgentToolRequest = {
    tool: "booking.apply",
    call_id: "book_target_2",
    arguments: {
      first_name: "Ivan",
      last_name: "Petrov",
      service: "cleaning",
      requested_date: "2027-08-15",
      requested_time: "10:00",
    },
  };
  const result: RuntimeAgentToolResult = {
    tool: "booking.apply",
    call_id: "book_target_2",
    status: "success",
    data: {
      booking_status: "missing_phone",
      created_visit: false,
      may_claim_booked: false,
    },
  };

  const updated = postUpdateBookingSubjects({
    current: makeState(),
    toolRequests: [request],
    toolResults: [result],
    bookingApplyResolution: {
      call_id: "book_target_2",
      subject_id: "subject_2" as SubjectId,
    },
  });

  const sender = updated.subjects.find((subject) => subject.id === "subject_1");
  const target = updated.subjects.find((subject) => subject.id === "subject_2");
  assert.ok(sender);
  assert.ok(target);
  assert.equal(sender.patient_name, "Sender Person");
  assert.equal(sender.service, null);
  assert.equal(sender.slot, null);
  assert.equal(target.patient_name, "Ivan Petrov");
  assert.equal(target.service, "cleaning");
  assert.equal(target.slot, "2027-08-15T10:00");
  assert.equal(target.status, "collecting", "blocked booking must not promote target to booked");
});

test("R3i: RuntimeAgentTurnResult no longer exposes duplicate execution_subject_id transport", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const openaiAgent = readFileSync(resolve(dir, "../src/runtime/openaiRuntimeAgent.ts"), "utf8");
  const orchestrator = readFileSync(resolve(dir, "../src/runtime/runtimeTurnOrchestratorLegacy.ts"), "utf8");
  const subjectState = readFileSync(resolve(dir, "../src/runtime/bookingSubjectsState.ts"), "utf8");

  assert.doesNotMatch(openaiAgent, /execution_subject_id\?:/, "turn result must not expose duplicate execution_subject_id");
  assert.doesNotMatch(orchestrator, /result\.execution_subject_id/, "orchestrator must consume booking_apply_resolution only");
  assert.doesNotMatch(subjectState, /executionSubjectId\?:/, "post-turn subject update must not keep the legacy fallback parameter");
});

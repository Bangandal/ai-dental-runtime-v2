import assert from "node:assert/strict";
import test from "node:test";

import { executeRuntimeTurnToolBatch } from "../src/runtime/runtimeTurnToolBatch.ts";
import type { BookingProcessState } from "../src/runtime/bookingProcessState.ts";
import type { RuntimeAgentToolRequest } from "../src/runtime/openaiRuntimeAgent.ts";

const NOW = new Date("2099-08-21T12:00:00Z");
const INPUT = {
  clinic_id: "clinic_r3u",
  contact_id: "contact_r3u",
  case_id: null,
  user_message: "Запишите меня",
  locale: "ru",
  trace_id: "trace_r3u",
  channel_contact: {
    phone_number: "+420700111222",
    phone_source: "telegram_contact_button" as const,
  },
};

function provenState(): BookingProcessState {
  return {
    service_reason: "cleaning",
    first_name: "Eva",
    last_name: "Novak",
    selected_slot: { starts_at: "2099-08-22T10:00:00" },
    last_available_slots: [{ starts_at: "2099-08-22T10:00:00" }],
    active_availability_evidence: {
      availability_call_id: "avail_old",
      requested_date: "2099-08-22",
      requested_time: null,
      allowed_slot_keys: ["2099-08-22T10:00"],
      checked_at: NOW.toISOString(),
    },
    selected_slot_proof: {
      subject_id: "subject_1",
      availability_call_id: "avail_old",
      slot_key: "2099-08-22T10:00",
    },
    phone_trusted: true,
    phone_source: "telegram_contact_button",
    next_action: "ready_for_booking_apply",
    proof: {
      service_known: true,
      name_known: true,
      slot_known: true,
      trusted_phone_known: true,
      ready_for_booking_apply: true,
    },
  };
}

function apply(callId = "book_1"): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: callId,
    arguments: {
      subject_id: "subject_1",
      first_name: "Eva",
      last_name: "Novak",
      service: "cleaning",
      requested_date: "2099-08-22",
      requested_time: "10:00",
    },
  };
}

test("R3u: non-booking batch passes through shared kernel with no booking metadata", async () => {
  let kbCalls = 0;
  const result = await executeRuntimeTurnToolBatch({
    requests: [{ tool: "kb.search", call_id: "kb_1", arguments: { query: "price" } }],
    input: INPUT,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return { tool: "kb.search" as const, status: "success" as const, data: { chunks: [] } };
      },
    },
    booking_process_state: provenState(),
    booking_subjects: null,
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(kbCalls, 1);
  assert.equal(result.decision, "no_booking_apply");
  assert.deepEqual(result.tool_results.map((r) => r.call_id), ["kb_1"]);
  assert.equal(result.booking_apply_resolution, null);
});

test("R3u: availability refresh is reduced before booking legality and revokes old proof", async () => {
  let availabilityCalls = 0;
  let bookingCalls = 0;
  const result = await executeRuntimeTurnToolBatch({
    requests: [
      { tool: "availability.check", call_id: "avail_new", arguments: { requested_date: "2099-08-22" } },
      apply(),
    ],
    input: INPUT,
    executors: {
      "availability.check": async () => {
        availabilityCalls++;
        return {
          tool: "availability.check" as const,
          status: "success" as const,
          data: {
            slots: [{ slot_id: "slot_new", starts_at: "2099-08-22T10:00:00", ends_at: "2099-08-22T10:30:00" }],
          },
        };
      },
      "booking.apply": async () => {
        bookingCalls++;
        return { tool: "booking.apply" as const, status: "success" as const, data: { booking_status: "visit_created", created_visit: true } };
      },
    },
    booking_process_state: provenState(),
    booking_subjects: null,
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(availabilityCalls, 1);
  assert.equal(bookingCalls, 0, "fresh availability must revoke prior proof before write preflight");
  assert.equal(result.booking_process_state.active_availability_evidence?.availability_call_id, "avail_new");
  assert.equal(result.booking_process_state.selected_slot_proof, null);
  assert.equal(result.decision, "booking_preflight_blocked");
  assert.equal(result.booking_preflight_guard_code, "missing_slot_proof");
  assert.deepEqual(result.tool_results.map((r) => r.call_id), ["avail_new", "book_1"]);
});

test("R3u: independent read plus proven booking executes one read and exactly one write", async () => {
  let kbCalls = 0;
  let bookingCalls = 0;
  const result = await executeRuntimeTurnToolBatch({
    requests: [
      { tool: "kb.search", call_id: "kb_1", arguments: { query: "price" } },
      apply(),
    ],
    input: INPUT,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return { tool: "kb.search" as const, status: "success" as const, data: { chunks: [{ text: "price" }] } };
      },
      "booking.apply": async () => {
        bookingCalls++;
        return {
          tool: "booking.apply" as const,
          status: "success" as const,
          data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true },
        };
      },
    },
    booking_process_state: provenState(),
    booking_subjects: null,
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(kbCalls, 1);
  assert.equal(bookingCalls, 1);
  assert.equal(result.decision, "booking_executed");
  assert.equal(result.execution_subject_id, "subject_1");
  assert.equal(result.booking_apply_resolution?.call_id, "book_1");
  assert.deepEqual(result.tool_results.map((r) => r.call_id), ["kb_1", "book_1"]);
});

test("R3u: same-batch select_slot plus booking.apply remains a protocol-complete dependency conflict", async () => {
  let bookingCalls = 0;
  const result = await executeRuntimeTurnToolBatch({
    requests: [
      {
        tool: "booking.select_slot",
        call_id: "select_1",
        arguments: { subject_id: "subject_1", requested_date: "2099-08-22", requested_time: "10:00" },
      },
      apply(),
      { tool: "kb.search", call_id: "kb_denied", arguments: { query: "price" } },
    ],
    input: INPUT,
    executors: {
      "booking.apply": async () => {
        bookingCalls++;
        return { tool: "booking.apply" as const, status: "success" as const, data: {} };
      },
    },
    booking_process_state: provenState(),
    booking_subjects: null,
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(bookingCalls, 0);
  assert.equal(result.decision, "select_apply_conflict");
  assert.deepEqual(new Set(result.tool_results.map((r) => r.call_id)), new Set(["select_1", "book_1", "kb_denied"]));
  assert.equal((result.tool_results.find((r) => r.call_id === "book_1")?.data as Record<string, unknown>)?.booking_status, "slot_not_verified");
});

test("R3u: multiple booking.apply requests abort the whole batch without executing siblings", async () => {
  let kbCalls = 0;
  let bookingCalls = 0;
  const result = await executeRuntimeTurnToolBatch({
    requests: [
      { tool: "kb.search", call_id: "kb_abort", arguments: { query: "price" } },
      apply("book_a"),
      apply("book_b"),
    ],
    input: INPUT,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return { tool: "kb.search" as const, status: "success" as const, data: {} };
      },
      "booking.apply": async () => {
        bookingCalls++;
        return { tool: "booking.apply" as const, status: "success" as const, data: {} };
      },
    },
    booking_process_state: provenState(),
    booking_subjects: null,
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(kbCalls, 0);
  assert.equal(bookingCalls, 0);
  assert.equal(result.decision, "multiple_booking_apply");
  assert.deepEqual(result.tool_results.map((r) => r.call_id), ["kb_abort", "book_a", "book_b"]);
  assert.equal(result.tool_results[0]?.status, "denied");
});

test("R3u: prior booking write attempt blocks a later booking batch without executing any sibling", async () => {
  let kbCalls = 0;
  let bookingCalls = 0;
  const result = await executeRuntimeTurnToolBatch({
    requests: [
      { tool: "kb.search", call_id: "kb_abort", arguments: { query: "price" } },
      apply("book_second"),
    ],
    input: INPUT,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return { tool: "kb.search" as const, status: "success" as const, data: {} };
      },
      "booking.apply": async () => {
        bookingCalls++;
        return { tool: "booking.apply" as const, status: "success" as const, data: {} };
      },
    },
    booking_process_state: provenState(),
    booking_subjects: null,
    previous_booking_apply_resolution: { call_id: "book_first", subject_id: "subject_1" },
    now: NOW,
    timezone: "Europe/Prague",
  });

  assert.equal(kbCalls, 0);
  assert.equal(bookingCalls, 0);
  assert.equal(result.decision, "write_already_attempted");
  assert.deepEqual(result.tool_results.map((r) => r.call_id), ["kb_abort", "book_second"]);
});

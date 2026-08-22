import assert from "node:assert/strict";
import test from "node:test";

import { executeRuntimeToolBatchKernel } from "../src/runtime/runtimeToolBatchKernel.ts";
import type { BookingProcessState } from "../src/runtime/bookingProcessState.ts";

const NOW = new Date("2099-08-21T12:00:00Z");
const INPUT = {
  clinic_id: "clinic_r3r",
  contact_id: "contact_r3r",
  case_id: null,
  user_message: "Запишите меня",
  locale: "ru",
  trace_id: "trace_r3r",
};

function provenState(): BookingProcessState {
  return {
    trusted_phone_available: true,
    selected_slot: { starts_at: "2099-08-22T10:00:00" },
    last_available_slots: [{ starts_at: "2099-08-22T10:00:00" }],
    active_availability_evidence: {
      availability_call_id: "avail_old",
      requested_date: "2099-08-22",
      requested_time: null,
      allowed_slot_keys: ["2099-08-22T10:00"],
    },
    selected_slot_proof: {
      subject_id: "subject_1",
      availability_call_id: "avail_old",
      slot_key: "2099-08-22T10:00",
    },
    updated_at: NOW.toISOString(),
  };
}

const BOOKING_APPLY = {
  tool: "booking.apply" as const,
  call_id: "book_1",
  arguments: {
    subject_id: "subject_1",
    first_name: "Eva",
    last_name: "Novak",
    service: "cleaning",
    requested_date: "2099-08-22",
    requested_time: "10:00",
  },
};

test("R3r: fresh availability in a booking batch clears old slot proof before booking.apply can be evaluated", async () => {
  const result = await executeRuntimeToolBatchKernel({
    requests: [
      { tool: "availability.check", call_id: "avail_new", arguments: { requested_date: "2099-08-22" } },
      BOOKING_APPLY,
    ],
    input: INPUT,
    executors: {
      "availability.check": async () => ({
        tool: "availability.check" as const,
        status: "success" as const,
        data: {
          slots: [{
            slot_id: "slot_new",
            starts_at: "2099-08-22T10:00:00",
            ends_at: "2099-08-22T10:30:00",
          }],
        },
      }),
    },
    prior_booking_process_state: provenState(),
    subjects: [{ id: "subject_1" }],
    channel_contact: { phone_number: "+420700111222", phone_source: "telegram_contact_button" },
    now: NOW,
  });

  assert.equal(result.pending_booking_apply?.call_id, "book_1");
  assert.deepEqual(result.tool_results.map((item) => item.call_id), ["avail_new"]);
  assert.equal(result.booking_process_state.active_availability_evidence?.availability_call_id, "avail_new");
  assert.equal(result.booking_process_state.selected_slot, null);
  assert.equal(result.booking_process_state.selected_slot_proof, null, "availability refresh must revoke the old proof before write preflight");
});

test("R3r: independent read plus booking.apply executes the read and leaves proven booking state intact", async () => {
  let kbCalls = 0;
  const prior = provenState();
  const result = await executeRuntimeToolBatchKernel({
    requests: [
      { tool: "kb.search", call_id: "kb_1", arguments: { query: "price" } },
      BOOKING_APPLY,
    ],
    input: INPUT,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return {
          tool: "kb.search" as const,
          status: "success" as const,
          data: { query: "price", chunks: [] },
        };
      },
    },
    prior_booking_process_state: prior,
    subjects: [{ id: "subject_1" }],
    now: NOW,
  });

  assert.equal(kbCalls, 1);
  assert.deepEqual(result.tool_results.map((item) => item.call_id), ["kb_1"]);
  assert.equal(result.pending_booking_apply?.call_id, "book_1");
  assert.equal(result.booking_process_state.selected_slot_proof?.slot_key, "2099-08-22T10:00");
});

test("R3r: select_slot plus booking.apply remains a protocol-complete dependency conflict", async () => {
  const result = await executeRuntimeToolBatchKernel({
    requests: [
      { tool: "booking.select_slot", call_id: "select_1", arguments: { subject_id: "subject_1", requested_date: "2099-08-22", requested_time: "10:00" } },
      BOOKING_APPLY,
      { tool: "kb.search", call_id: "kb_denied", arguments: { query: "info" } },
    ],
    input: INPUT,
    executors: {},
    prior_booking_process_state: provenState(),
    subjects: [{ id: "subject_1" }],
    now: NOW,
  });

  assert.ok(result.select_apply_conflict);
  assert.deepEqual(new Set(result.tool_results.map((item) => item.call_id)), new Set(["select_1", "book_1", "kb_denied"]));
  const bookingResult = result.tool_results.find((item) => item.call_id === "book_1");
  assert.equal((bookingResult?.data as Record<string, unknown>)?.booking_status, "slot_not_verified");
  assert.equal(result.booking_process_state.selected_slot_proof?.slot_key, "2099-08-22T10:00");
});

test("R3r: kernel preserves model request order for every result it owns", async () => {
  const result = await executeRuntimeToolBatchKernel({
    requests: [
      { tool: "kb.search", call_id: "kb_a", arguments: { query: "a" } },
      { tool: "booking.select_slot", call_id: "select_a", arguments: { subject_id: "subject_1", requested_date: "2099-08-22", requested_time: "10:00" } },
      { tool: "appointment.lookup", call_id: "lookup_a", arguments: {} },
    ],
    input: INPUT,
    executors: {
      "kb.search": async () => ({ tool: "kb.search" as const, status: "success" as const, data: { chunks: [] } }),
      "appointment.lookup": async () => ({
        tool: "appointment.lookup" as const,
        status: "success" as const,
        data: { lookup_status: "no_upcoming_appointments", appointments: [] },
      } as any),
    },
    prior_booking_process_state: provenState(),
    subjects: [{ id: "subject_1" }],
    now: NOW,
  });

  assert.deepEqual(result.tool_results.map((item) => item.call_id), ["kb_a", "select_a", "lookup_a"]);
});

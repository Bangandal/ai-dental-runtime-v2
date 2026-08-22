import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type { BookingProcessState } from "../src/runtime/bookingProcessState.ts";

const NOW = new Date("2099-08-21T12:00:00Z");
const CONTACT = { phone_number: "+420700111222", phone_source: "telegram_contact_button" as const };

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

const BOOKING_ARGS = {
  subject_id: "subject_1",
  first_name: "Eva",
  last_name: "Novak",
  service: "cleaning",
  requested_date: "2099-08-22",
  requested_time: "10:00",
};

function stateRepo(saved: BookingProcessState[]) {
  return {
    async loadState() {
      return provenState();
    },
    async saveState(_key: unknown, state: BookingProcessState) {
      saved.push(state);
    },
  };
}

test("R3r: availability refresh plus booking.apply resolves both calls but blocks write against revoked proof", async () => {
  let modelCalls = 0;
  let availabilityCalls = 0;
  let bookingCalls = 0;
  const saved: BookingProcessState[] = [];

  const caller: RuntimeAgentCaller = async (input) => {
    modelCalls++;
    if (modelCalls === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_r3r_refresh",
        tool_requests: [{ tool: "kb.search", call_id: "kb_first", arguments: { query: "start" } }],
      };
    }
    if (modelCalls === 2) {
      return {
        type: "tool_requests",
        conversation_id: "conv_r3r_refresh",
        tool_requests: [
          { tool: "availability.check", call_id: "avail_refresh", arguments: { requested_date: "2099-08-22" } },
          { tool: "booking.apply", call_id: "book_refresh", arguments: BOOKING_ARGS },
        ],
      };
    }

    assert.equal(input.conversation_id, "conv_r3r_refresh");
    assert.equal(input.input.tool_definitions, undefined, "third model step is the bounded terminal step");
    assert.deepEqual(
      input.input.tool_results?.map((item) => item.call_id),
      ["avail_refresh", "book_refresh"],
      "every second-batch call id must be closed before final response",
    );
    const bookingResult = input.input.tool_results?.find((item) => item.call_id === "book_refresh");
    assert.equal((bookingResult?.data as Record<string, unknown>)?.booking_status, "slot_not_verified");
    return {
      type: "final_response",
      conversation_id: "conv_r3r_refresh",
      final_response: { final_patient_reply: "После новой проверки нужно снова выбрать слот." },
    };
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    now: NOW,
    executors: {
      "kb.search": async () => ({ tool: "kb.search" as const, status: "success" as const, data: { chunks: [] } }),
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
        return { tool: "booking.apply" as const, status: "success" as const, data: { booking_status: "visit_created", created_visit: true, may_claim_booked: true } };
      },
    },
    bookingProcessStateRepository: stateRepo(saved),
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_r3r",
    contact_id: "contact_refresh",
    case_id: null,
    conversation_id: "conv_r3r_refresh",
    user_message: "Проверь и запиши",
    locale: "ru",
    trace_id: "trace_refresh",
    channel_contact: CONTACT,
  });

  assert.equal(modelCalls, 3);
  assert.equal(availabilityCalls, 1);
  assert.equal(bookingCalls, 0, "fresh availability must revoke proof before booking write preflight");
  assert.equal(result.conversation_id, "conv_r3r_refresh");
  assert.notEqual(result.conversation_id_resumable, false);
  assert.ok(saved.some((state) => state.selected_slot_proof === null), "revoked proof must be persisted");
});

test("R3r: independent read plus proven booking.apply executes both and resolves the full batch in one conversation", async () => {
  let modelCalls = 0;
  let kbCalls = 0;
  let bookingCalls = 0;
  const saved: BookingProcessState[] = [];

  const caller: RuntimeAgentCaller = async (input) => {
    modelCalls++;
    if (modelCalls === 1) {
      return {
        type: "tool_requests",
        conversation_id: "conv_r3r_write",
        tool_requests: [{ tool: "kb.search", call_id: "kb_first", arguments: { query: "start" } }],
      };
    }
    if (modelCalls === 2) {
      return {
        type: "tool_requests",
        conversation_id: "conv_r3r_write",
        tool_requests: [
          { tool: "kb.search", call_id: "kb_second", arguments: { query: "price" } },
          { tool: "booking.apply", call_id: "book_second", arguments: BOOKING_ARGS },
        ],
      };
    }

    assert.equal(input.conversation_id, "conv_r3r_write");
    assert.equal(input.input.tool_definitions, undefined);
    assert.deepEqual(input.input.tool_results?.map((item) => item.call_id), ["kb_second", "book_second"]);
    const bookingResult = input.input.tool_results?.find((item) => item.call_id === "book_second");
    assert.equal((bookingResult?.data as Record<string, unknown>)?.booking_status, "visit_created");
    return {
      type: "final_response",
      conversation_id: "conv_r3r_write",
      final_response: { final_patient_reply: "Запись создана." },
    };
  };

  const loop = createRuntimeAgentLoop({
    model: "test-model",
    caller,
    now: NOW,
    executors: {
      "kb.search": async () => {
        kbCalls++;
        return { tool: "kb.search" as const, status: "success" as const, data: { chunks: [{ chunk_id: "faq", text: "price" }] } };
      },
      "booking.apply": async () => {
        bookingCalls++;
        return {
          tool: "booking.apply" as const,
          status: "success" as const,
          data: {
            booking_status: "visit_created",
            created_visit: true,
            may_claim_booked: true,
            cliniccard_visit_id: "visit_r3r",
            visit_start: "2099-08-22 10:00:00",
            visit_end: "2099-08-22 10:30:00",
          },
        };
      },
    },
    bookingProcessStateRepository: stateRepo(saved),
  });

  const result = await loop.runTurn({
    clinic_id: "clinic_r3r",
    contact_id: "contact_write",
    case_id: null,
    conversation_id: "conv_r3r_write",
    user_message: "Сколько стоит и запиши",
    locale: "ru",
    trace_id: "trace_write",
    channel_contact: CONTACT,
  });

  assert.equal(modelCalls, 3);
  assert.equal(kbCalls, 2, "both read batches execute");
  assert.equal(bookingCalls, 1, "booking write executes exactly once");
  assert.equal(result.final_patient_reply, "Запись создана.");
  assert.equal(result.conversation_id, "conv_r3r_write");
  assert.notEqual(result.conversation_id_resumable, false);
  assert.equal(result.booking_apply_resolution?.call_id, "book_second");
  assert.equal(result.execution_subject_id, "subject_1");
});

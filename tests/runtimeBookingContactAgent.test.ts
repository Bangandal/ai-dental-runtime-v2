import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSameBatchBookingStage,
  createRuntimeAgentWithBookingContactBridge,
  type RuntimeAgentLoopFactory,
} from "../src/runtime/runtimeBookingContactAgent.ts";
import type {
  RuntimeAgentToolRequest,
  RuntimeAgentToolResult,
  RuntimeAgentTurnInput,
} from "../src/runtime/openaiRuntimeAgent.ts";
import type {
  BookingContact,
  BookingSubject,
  BookingSubjectsState,
} from "../src/runtime/bookingSubjectsState.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";
import type { ToolExecutionResult } from "../src/runtime/toolResults.ts";

function contact(overrides: Partial<BookingContact> = {}): BookingContact {
  return {
    phone_number: "+420111222333",
    source: "telegram_contact_button",
    trust: "trusted",
    owner_subject_id: "subject_1",
    collected_at: "2026-08-21T04:00:00Z",
    ...overrides,
  };
}

function subject(id: BookingSubject["id"], overrides: Partial<BookingSubject> = {}): BookingSubject {
  return {
    id,
    role: id === "subject_1" ? "sender" : "mentioned_person",
    label: null,
    patient_name: null,
    service: null,
    slot: null,
    booking_contact: null,
    status: "collecting",
    missing: [],
    ...overrides,
  };
}

function registry(subjects: BookingSubject[]): BookingSubjectsState {
  return {
    version: 3,
    status: "active",
    active_subject_id: subjects[0]?.id ?? "subject_1",
    subjects,
    pending_typed_phone: null,
    max_subjects: 4,
  };
}

function bookingApply(subjectId: string): RuntimeAgentToolRequest {
  return {
    tool: "booking.apply",
    call_id: `call-${subjectId}`,
    arguments: {
      subject_id: subjectId,
      first_name: "Marta",
      last_name: "Koval",
      service: "consultation",
      requested_date: "2099-08-21",
      requested_time: "10:00",
    },
  };
}

function selectSlot(subjectId: string, callId = `select-${subjectId}`): RuntimeAgentToolRequest {
  return {
    tool: "booking.select_slot",
    call_id: callId,
    arguments: {
      subject_id: subjectId,
      slot_key: "2099-08-21T10:00",
    },
  };
}

function baseInput(overrides: Partial<RuntimeAgentTurnInput> = {}): RuntimeAgentTurnInput {
  return {
    trace_id: "trace-r1-runtime-contact",
    clinic_id: "clinic_1",
    user_message: "book",
    ...overrides,
  };
}

function successfulBookingResult(): ToolExecutionResult {
  return {
    tool: "booking.apply",
    status: "success",
    data: {
      booking_status: "visit_created",
      created_visit: true,
      may_claim_booked: true,
      cliniccard_visit_id: "700",
    },
  } as ToolExecutionResult;
}

function loopFactoryThatExecutesBooking(): RuntimeAgentLoopFactory {
  return (deps) => ({
    async runTurn(input) {
      const output = await deps.caller({
        model: deps.model,
        system_instruction: "test",
        input: { message: input.user_message, context: {} },
      });
      if (output.type !== "tool_requests") {
        throw new Error("expected tool_requests");
      }

      const executor = deps.executors["booking.apply"];
      assert.ok(executor);
      await executor({
        clinic_id: input.clinic_id,
        phone_number: "+420000000000",
        phone_source: "legacy_loop_value",
        contact_phone_owner_subject_id: "subject_1",
      });

      return {
        final_patient_reply: "ok",
        tool_requests: output.tool_requests,
        tool_results: [],
      };
    },
  });
}

function makeAgent(params: {
  request: RuntimeAgentToolRequest;
  observed: ToolExecutionContext[];
}) {
  return createRuntimeAgentWithBookingContactBridge(
    {
      model: "test-model",
      caller: async () => ({
        type: "tool_requests",
        tool_requests: [params.request],
      }),
      executors: {
        "booking.apply": async (context) => {
          params.observed.push(context);
          return successfulBookingResult();
        },
      },
    },
    loopFactoryThatExecutesBooking(),
  );
}

test("R1-RUNTIME-CONTACT-1: shared sender contact reaches write executor as non-patient identity", async () => {
  const observed: ToolExecutionContext[] = [];
  const booking_subjects = registry([
    subject("subject_1", { booking_contact: contact() }),
    subject("subject_2", {
      patient_name: "Marta Koval",
      booking_contact: contact({
        source: "shared_from_subject",
        trust: "trusted_contact_owner",
        owner_subject_id: "subject_1",
      }),
    }),
  ]);

  const agent = makeAgent({ request: bookingApply("subject_2"), observed });
  await agent.runTurn(baseInput({ booking_subjects }));

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.phone_number, "+420111222333");
  assert.equal(observed[0]?.phone_source, "telegram_contact_button");
  assert.equal(observed[0]?.phone_belongs_to_patient, false);
  assert.equal(observed[0]?.contact_phone_owner_subject_id, undefined);
});

test("R1-RUNTIME-CONTACT-2: subject_2 bootstrap treats channel sender phone as contactability only", async () => {
  const observed: ToolExecutionContext[] = [];
  const agent = makeAgent({ request: bookingApply("subject_2"), observed });

  await agent.runTurn(baseInput({
    channel_contact: {
      phone_number: "+420555444333",
      phone_source: "telegram_contact_button",
    },
  }));

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.phone_number, "+420555444333");
  assert.equal(observed[0]?.phone_belongs_to_patient, false);
});

test("R1-RUNTIME-CONTACT-3: single-person subject_1 channel contact stays patient-owned", async () => {
  const observed: ToolExecutionContext[] = [];
  const request: RuntimeAgentToolRequest = {
    ...bookingApply("subject_1"),
    arguments: {
      ...bookingApply("subject_1").arguments,
      first_name: "Anna",
      last_name: "Koval",
    },
  };
  const agent = makeAgent({ request, observed });

  await agent.runTurn(baseInput({
    channel_contact: {
      phone_number: "+420777666555",
      phone_source: "telegram_contact_button",
    },
  }));

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.phone_number, "+420777666555");
  assert.equal(observed[0]?.phone_belongs_to_patient, true);
});

test("R1-RUNTIME-CONTACT-4: unresolved subject cannot inherit any legacy phone at write boundary", async () => {
  const observed: ToolExecutionContext[] = [];
  const agent = makeAgent({ request: bookingApply("subject_9"), observed });

  await agent.runTurn(baseInput({
    channel_contact: {
      phone_number: "+420777666555",
      phone_source: "telegram_contact_button",
    },
  }));

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.phone_number, undefined);
  assert.equal(observed[0]?.phone_source, undefined);
  assert.equal(observed[0]?.phone_belongs_to_patient, undefined);
  assert.equal(observed[0]?.contact_phone_owner_subject_id, undefined);
});

test("PF-004a-1: same-person select_slot + booking.apply stages booking and forwards selection first", () => {
  const select = selectSlot("subject_1", "select-self");
  const booking = bookingApply("subject_1");
  const stage = buildSameBatchBookingStage([select, booking]);

  assert.ok(stage);
  assert.equal(stage.booking_apply.call_id, booking.call_id);
  assert.equal(stage.select_slot_call_id, select.call_id);
  assert.deepEqual(stage.forwarded_requests.map((request) => request.call_id), [select.call_id]);
});

test("PF-004a-2: different people are never collapsed into one staged booking", () => {
  const stage = buildSameBatchBookingStage([
    selectSlot("subject_1", "select-person-1"),
    bookingApply("subject_2"),
  ]);

  assert.equal(stage, null);
});

test("PF-004a-3: subject_2 same-batch flow bootstraps before selection and replays booking without a second model decision", async () => {
  let actualCallerCalls = 0;
  let sawBootstrappedSubject2 = false;
  let replayedBooking: RuntimeAgentToolRequest | null = null;

  const select = selectSlot("subject_2", "select-person-2");
  const booking = bookingApply("subject_2");

  const loopFactory: RuntimeAgentLoopFactory = (deps) => ({
    async runTurn(input) {
      const first = await deps.caller({
        model: deps.model,
        system_instruction: "test",
        input: { message: input.user_message, context: {} },
      });
      assert.equal(first.type, "tool_requests");
      if (first.type !== "tool_requests") throw new Error("expected first tool batch");

      assert.deepEqual(first.tool_requests.map((request) => request.call_id), [select.call_id]);
      sawBootstrappedSubject2 = input.booking_subjects?.subjects.some((item) => item.id === "subject_2") === true;

      const selectResult: RuntimeAgentToolResult = {
        tool: "booking.select_slot",
        call_id: select.call_id,
        status: "success",
        data: { selected_slot: { starts_at: "2099-08-21T10:00:00" } },
      };
      const second = await deps.caller({
        model: deps.model,
        conversation_id: first.conversation_id,
        system_instruction: "test",
        input: {
          message: input.user_message,
          context: {},
          tool_results: [selectResult],
        },
      });
      assert.equal(second.type, "tool_requests");
      if (second.type !== "tool_requests") throw new Error("expected replayed booking request");

      replayedBooking = second.tool_requests[0] ?? null;
      return {
        final_patient_reply: "ok",
        tool_requests: [...first.tool_requests, ...second.tool_requests],
        tool_results: [selectResult],
      };
    },
  });

  const agent = createRuntimeAgentWithBookingContactBridge(
    {
      model: "test-model",
      caller: async () => {
        actualCallerCalls += 1;
        if (actualCallerCalls > 1) throw new Error("same-batch staging must not ask the model to decide booking again");
        return {
          type: "tool_requests",
          conversation_id: "conv-pf004a",
          tool_requests: [select, booking],
        };
      },
      executors: {},
    },
    loopFactory,
  );

  await agent.runTurn(baseInput({
    channel_contact: {
      phone_number: "+420555444333",
      phone_source: "telegram_contact_button",
    },
  }));

  assert.equal(actualCallerCalls, 1);
  assert.equal(sawBootstrappedSubject2, true);
  assert.ok(replayedBooking);
  assert.equal(replayedBooking?.tool, "booking.apply");
  assert.equal(replayedBooking?.arguments.subject_id, "subject_2");
});

test("PF-004a-4: mismatched select/apply subjects stay on the legacy path unchanged", async () => {
  let actualCallerCalls = 0;
  let forwardedCallIds: string[] = [];

  const select = selectSlot("subject_1", "select-mismatch");
  const booking = bookingApply("subject_2");

  const loopFactory: RuntimeAgentLoopFactory = (deps) => ({
    async runTurn(input) {
      const output = await deps.caller({
        model: deps.model,
        system_instruction: "test",
        input: { message: input.user_message, context: {} },
      });
      assert.equal(output.type, "tool_requests");
      if (output.type !== "tool_requests") throw new Error("expected tool requests");
      forwardedCallIds = output.tool_requests.map((request) => request.call_id);
      return {
        final_patient_reply: "ok",
        tool_requests: output.tool_requests,
        tool_results: [],
      };
    },
  });

  const agent = createRuntimeAgentWithBookingContactBridge(
    {
      model: "test-model",
      caller: async () => {
        actualCallerCalls += 1;
        return {
          type: "tool_requests",
          tool_requests: [select, booking],
        };
      },
      executors: {},
    },
    loopFactory,
  );

  await agent.runTurn(baseInput());

  assert.equal(actualCallerCalls, 1);
  assert.deepEqual(forwardedCallIds, [select.call_id, booking.call_id]);
});

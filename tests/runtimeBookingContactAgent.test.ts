import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeAgentWithBookingContactBridge,
  type RuntimeAgentLoopFactory,
} from "../src/runtime/runtimeBookingContactAgent.ts";
import type {
  RuntimeAgentToolRequest,
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

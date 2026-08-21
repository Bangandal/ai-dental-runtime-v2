import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAIToolDefinitions,
  createOpenAIRuntimeAgentCaller,
} from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";
import { resolveBookingExecutionSubject } from "../src/runtime/bookingSubjectExecutionResolver.ts";

const BOOKING_ARGS = {
  first_name: "Eva",
  last_name: "Koval",
  service: "consultation",
  requested_date: "2099-08-21",
  requested_time: "14:00",
};

function makeInput(activeSubjectId?: string) {
  return {
    model: "gpt-test",
    conversation_id: "conv_r3b",
    system_instruction: "system",
    input: {
      message: "Запишите на 14:00",
      context: {
        runtime_context: activeSubjectId
          ? {
              booking_subjects: {
                version: 3,
                status: "active",
                active_subject_id: activeSubjectId,
                subjects: [],
                max_subjects: 4,
              },
            }
          : null,
      },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  };
}

function bookingApplyDefinition() {
  const defs = buildOpenAIToolDefinitions(makeInput() as never);
  return defs.find((def) => def.name === "booking_apply") as Record<string, any> | undefined;
}

function callerForToolCalls(toolCalls: Array<Record<string, unknown>>) {
  return createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          conversation_id: "conv_r3b",
          tool_calls: toolCalls,
        }),
      },
    },
  });
}

function applyCall(argumentsValue: Record<string, unknown>) {
  return {
    name: "booking_apply",
    call_id: "call_apply",
    arguments: JSON.stringify(argumentsValue),
  };
}

function selectCall() {
  return {
    name: "booking_select_slot",
    call_id: "call_select",
    arguments: JSON.stringify({
      requested_date: "2099-08-21",
      requested_time: "14:00",
    }),
  };
}

test("R3b contract: booking_apply exposes semantic patient_target and never subject_id", () => {
  const def = bookingApplyDefinition();
  assert.ok(def);
  assert.deepEqual(def.parameters.required, [
    "patient_target",
    "first_name",
    "last_name",
    "service",
    "requested_date",
    "requested_time",
  ]);
  assert.equal("subject_id" in def.parameters.properties, false);
  assert.deepEqual(def.parameters.properties.patient_target.enum, ["self", "other_person"]);
  assert.doesNotMatch(String(def.description), /subject_[1-4]|subject_id/i);
  assert.match(String(def.description), /patient_target/);
});

test("R3b contract: active other patient owns booking.apply target", async () => {
  const caller = callerForToolCalls([
    applyCall({
      ...BOOKING_ARGS,
      patient_target: "other_person",
      subject_id: "subject_1",
    }),
  ]);

  const result = await caller(makeInput("subject_3") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  const apply = result.tool_requests[0]!;
  assert.equal(apply.arguments.subject_id, "subject_3");
  assert.equal("patient_target" in apply.arguments, false);
});

test("R3b contract: active self maps to internal subject_1", async () => {
  const caller = callerForToolCalls([
    applyCall({ ...BOOKING_ARGS, patient_target: "self" }),
  ]);

  const result = await caller(makeInput("subject_1") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_1");
});

test("R3b bootstrap: first other-person booking maps to internal subject_2 without registry", async () => {
  const caller = callerForToolCalls([
    applyCall({ ...BOOKING_ARGS, patient_target: "other_person" }),
  ]);

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_2");
});

test("R3b bootstrap: simple self booking maps to internal subject_1 without registry", async () => {
  const caller = callerForToolCalls([
    applyCall({ ...BOOKING_ARGS, patient_target: "self" }),
  ]);

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_1");
});

test("R3b safety: semantic target conflicting with runtime active patient fails existing strict resolver", async () => {
  const caller = callerForToolCalls([
    applyCall({ ...BOOKING_ARGS, patient_target: "self" }),
  ]);
  const result = await caller(makeInput("subject_2") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;

  const apply = result.tool_requests[0]!;
  const resolution = resolveBookingExecutionSubject({
    version: 3,
    status: "active",
    active_subject_id: "subject_2",
    pending_typed_phone: null,
    max_subjects: 4,
    subjects: [
      { id: "subject_1", status: "collecting" },
      { id: "subject_2", status: "ready_for_booking" },
    ],
  } as never, apply.arguments);

  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.equal(resolution.reason, "invalid_subject_id_format");
});

test("R3b safety: malformed patient_target cannot fall back to hallucinated legacy subject_id", async () => {
  const caller = callerForToolCalls([
    applyCall({
      ...BOOKING_ARGS,
      patient_target: "subject_2",
      subject_id: "subject_2",
    }),
  ]);

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.notEqual(result.tool_requests[0]?.arguments.subject_id, "subject_2");
  assert.equal("patient_target" in result.tool_requests[0]!.arguments, false);
});

test("R3b compatibility: hidden legacy booking.apply without patient_target keeps old subject_id", async () => {
  const caller = callerForToolCalls([
    applyCall({ ...BOOKING_ARGS, subject_id: "subject_4" }),
  ]);

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_4");
});

test("R3b same-batch bootstrap: semantic other-person apply binds select_slot and apply to subject_2", async () => {
  const caller = callerForToolCalls([
    selectCall(),
    applyCall({ ...BOOKING_ARGS, patient_target: "other_person" }),
  ]);

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  const select = result.tool_requests.find((request) => request.tool === "booking.select_slot");
  const apply = result.tool_requests.find((request) => request.tool === "booking.apply");
  assert.equal(select?.arguments.subject_id, "subject_2");
  assert.equal(apply?.arguments.subject_id, "subject_2");
});

test("R3b same-batch established flow: runtime active subject_3 binds both selection and write", async () => {
  const caller = callerForToolCalls([
    selectCall(),
    applyCall({
      ...BOOKING_ARGS,
      patient_target: "other_person",
      subject_id: "subject_4",
    }),
  ]);

  const result = await caller(makeInput("subject_3") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  const select = result.tool_requests.find((request) => request.tool === "booking.select_slot");
  const apply = result.tool_requests.find((request) => request.tool === "booking.apply");
  assert.equal(select?.arguments.subject_id, "subject_3");
  assert.equal(apply?.arguments.subject_id, "subject_3");
});

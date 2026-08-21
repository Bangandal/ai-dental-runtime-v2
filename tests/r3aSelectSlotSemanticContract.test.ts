import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAIToolDefinitions,
  createOpenAIRuntimeAgentCaller,
} from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

function makeInput(activeSubjectId?: string) {
  return {
    model: "gpt-test",
    conversation_id: "conv_r3a",
    system_instruction: "system",
    input: {
      message: "14:00 подходит",
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

function selectSlotDefinition(input = makeInput()) {
  const defs = buildOpenAIToolDefinitions(input as never);
  return defs.find((def) => def.name === "booking_select_slot") as Record<string, any> | undefined;
}

test("R3a contract: booking_select_slot exposes only date/time, never subject_id", () => {
  const def = selectSlotDefinition();
  assert.ok(def);
  assert.deepEqual(def.parameters.required, ["requested_date", "requested_time"]);
  assert.equal("subject_id" in def.parameters.properties, false);
  assert.doesNotMatch(String(def.description), /subject_[1-4]|subject_id/i);
  assert.match(String(def.description), /active patient/i);
});

test("R3a contract: model select-slot call is bound to runtime active patient", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          conversation_id: "conv_r3a",
          tool_calls: [{
            name: "booking_select_slot",
            call_id: "call_select",
            arguments: JSON.stringify({
              requested_date: "2099-08-21",
              requested_time: "14:00",
            }),
          }],
        }),
      },
    },
  });

  const result = await caller(makeInput("subject_2") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.deepEqual(result.tool_requests[0]?.arguments, {
    requested_date: "2099-08-21",
    requested_time: "14:00",
    subject_id: "subject_2",
  });
});

test("R3a contract: hallucinated model subject_id cannot override runtime active patient", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          tool_calls: [{
            name: "booking_select_slot",
            call_id: "call_select",
            arguments: JSON.stringify({
              subject_id: "subject_4",
              requested_date: "2099-08-21",
              requested_time: "14:00",
            }),
          }],
        }),
      },
    },
  });

  const result = await caller(makeInput("subject_2") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_2");
});

test("R3a contract: simple self-booking defaults internal selection target to subject_1", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          tool_calls: [{
            name: "booking_select_slot",
            call_id: "call_select",
            arguments: JSON.stringify({
              requested_date: "2099-08-21",
              requested_time: "14:00",
            }),
          }],
        }),
      },
    },
  });

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_1");
});

test("R3a regression: first multi-patient same-batch selection inherits the one booking_apply target", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          tool_calls: [
            {
              name: "booking_select_slot",
              call_id: "call_select",
              arguments: JSON.stringify({
                requested_date: "2099-08-21",
                requested_time: "14:00",
              }),
            },
            {
              name: "booking_apply",
              call_id: "call_apply",
              arguments: JSON.stringify({
                subject_id: "subject_2",
                first_name: "Eva",
                last_name: "Koval",
                service: "consultation",
                requested_date: "2099-08-21",
                requested_time: "14:00",
              }),
            },
          ],
        }),
      },
    },
  });

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  const select = result.tool_requests.find((request) => request.tool === "booking.select_slot");
  const apply = result.tool_requests.find((request) => request.tool === "booking.apply");
  assert.equal(select?.arguments.subject_id, "subject_2");
  assert.equal(apply?.arguments.subject_id, "subject_2");
});

test("R3a regression: persisted active patient wins over conflicting same-batch booking_apply target", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          tool_calls: [
            {
              name: "booking_select_slot",
              call_id: "call_select",
              arguments: JSON.stringify({
                requested_date: "2099-08-21",
                requested_time: "14:00",
              }),
            },
            {
              name: "booking_apply",
              call_id: "call_apply",
              arguments: JSON.stringify({
                subject_id: "subject_4",
                first_name: "Eva",
                last_name: "Koval",
                service: "consultation",
                requested_date: "2099-08-21",
                requested_time: "14:00",
              }),
            },
          ],
        }),
      },
    },
  });

  const result = await caller(makeInput("subject_2") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  const select = result.tool_requests.find((request) => request.tool === "booking.select_slot");
  assert.equal(select?.arguments.subject_id, "subject_2");
});

test("R3 migration sentinel: model-facing booking tools no longer expose subject_id", () => {
  const defs = buildOpenAIToolDefinitions(makeInput() as never);
  for (const name of ["booking_select_slot", "booking_apply", "appointment_lookup"]) {
    const def = defs.find((item) => item.name === name) as Record<string, any> | undefined;
    assert.ok(def, `${name} definition must exist`);
    assert.equal(def.parameters.required.includes("subject_id"), false, `${name} required args`);
    assert.equal("subject_id" in def.parameters.properties, false, `${name} properties`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAIToolDefinitions,
  createOpenAIRuntimeAgentCaller,
} from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";
import { createAppointmentLookupExecutor } from "../src/integrations/cliniccard/appointmentLookupExecutor.ts";

function makeInput(activeSubjectId?: string) {
  return {
    model: "gpt-test",
    conversation_id: "conv_r3c",
    system_instruction: "system",
    input: {
      message: "Какие у меня записи?",
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

function callerForLookup(args: Record<string, unknown>) {
  return createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          conversation_id: "conv_r3c",
          tool_calls: [{
            name: "appointment_lookup",
            call_id: "call_lookup",
            arguments: JSON.stringify(args),
          }],
        }),
      },
    },
  });
}

function lookupDefinition() {
  const defs = buildOpenAIToolDefinitions(makeInput() as never);
  return defs.find((def) => def.name === "appointment_lookup") as Record<string, any> | undefined;
}

test("R3c contract: appointment_lookup exposes patient_target, never subject_id", () => {
  const def = lookupDefinition();
  assert.ok(def);
  assert.deepEqual(def.parameters.required, ["patient_target"]);
  assert.deepEqual(def.parameters.properties.patient_target.enum, ["self", "other_person"]);
  assert.equal("subject_id" in def.parameters.properties, false);
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), ["date_from", "date_to", "patient_target"].sort());
  assert.doesNotMatch(String(def.description), /subject_[1-4]|subject_id/i);
});

test("R3c contract: existing active other person owns lookup target", async () => {
  const caller = callerForLookup({
    patient_target: "other_person",
    subject_id: "subject_1",
    date_from: "2099-08-01",
    date_to: "2099-08-31",
  });

  const result = await caller(makeInput("subject_3") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  const lookup = result.tool_requests[0]!;
  assert.equal(lookup.arguments.subject_id, "subject_3");
  assert.equal(lookup.arguments.date_from, "2099-08-01");
  assert.equal(lookup.arguments.date_to, "2099-08-31");
  assert.equal("patient_target" in lookup.arguments, false);
});

test("R3c contract: self lookup maps to subject_1", async () => {
  const caller = callerForLookup({ patient_target: "self" });
  const result = await caller(makeInput("subject_1") as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_1");
});

test("R3c safety: other-person lookup without registry cannot borrow sender identity", async () => {
  const caller = callerForLookup({ patient_target: "other_person" });
  const normalized = await caller(makeInput() as never);
  assert.equal(normalized.type, "tool_requests");
  if (normalized.type !== "tool_requests") return;
  const lookup = normalized.tool_requests[0]!;
  assert.equal(lookup.arguments.subject_id, "subject_2");

  let adapterCreated = false;
  const executor = createAppointmentLookupExecutor({
    env: {
      CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
    },
    adapterFactory: () => {
      adapterCreated = true;
      throw new Error("ClinicCard must not be reached when other-person registry is absent");
    },
  });

  const result = await executor({
    clinic_id: "clinic_1",
    lookup_subject_id: String(lookup.arguments.subject_id),
    lookup_booking_subjects: null,
    phone_number: "+420111222333",
    phone_source: "telegram_contact_button",
  });

  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  assert.equal(result.data.lookup_status, "subject_resolution_conflict");
  assert.equal(result.data.required_next_action, "clarify_subject");
  assert.equal(adapterCreated, false);
});

test("R3c safety: semantic target conflicting with runtime active patient becomes fail-closed internal target", async () => {
  const caller = callerForLookup({ patient_target: "self" });
  const normalized = await caller(makeInput("subject_2") as never);
  assert.equal(normalized.type, "tool_requests");
  if (normalized.type !== "tool_requests") return;
  const lookup = normalized.tool_requests[0]!;
  assert.notEqual(lookup.arguments.subject_id, "subject_1");
  assert.notEqual(lookup.arguments.subject_id, "subject_2");

  const executor = createAppointmentLookupExecutor({
    env: { CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1" },
  });
  const result = await executor({
    clinic_id: "clinic_1",
    lookup_subject_id: String(lookup.arguments.subject_id),
    lookup_booking_subjects: {
      subjects: [
        { id: "subject_1", booking_contact: null },
        { id: "subject_2", booking_contact: null },
      ],
    },
  });
  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  assert.equal(result.data.lookup_status, "subject_resolution_conflict");
});

test("R3c safety: malformed patient_target cannot fall back to hallucinated subject_id", async () => {
  const caller = callerForLookup({
    patient_target: "subject_2",
    subject_id: "subject_2",
  });
  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.notEqual(result.tool_requests[0]?.arguments.subject_id, "subject_2");
  assert.equal("patient_target" in result.tool_requests[0]!.arguments, false);
});

test("R3c compatibility: hidden legacy lookup without patient_target preserves old subject_id", async () => {
  const caller = callerForLookup({
    subject_id: "subject_4",
    date_from: "2099-08-01",
  });
  const result = await caller(makeInput() as never);
  assert.equal(result.type, "tool_requests");
  if (result.type !== "tool_requests") return;
  assert.equal(result.tool_requests[0]?.arguments.subject_id, "subject_4");
  assert.equal(result.tool_requests[0]?.arguments.date_from, "2099-08-01");
});

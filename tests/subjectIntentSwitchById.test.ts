import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIRuntimeAgentCaller } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";
import {
  applySubjectIntent,
  type BookingSubjectsState,
} from "../src/runtime/bookingSubjectsState.ts";

function makeInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_switch_by_id",
    system_instruction: "system",
    input: {
      message: "переключись на маму",
      context: { clinic_id: "c1" },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  };
}

function makeOutputResponse(text: string) {
  return {
    conversation_id: "conv_switch_by_id",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  };
}

function makeSubjectsState(): BookingSubjectsState {
  return {
    version: 2,
    active_subject_id: "subject_1",
    pending_typed_phone: null,
    max_subjects: 4,
    subjects: [
      {
        id: "subject_1",
        role: "sender",
        label: "я",
        patient_name: "Мария",
        service: null,
        slot: null,
        booking_contact: null,
        status: "collecting",
        missing: ["service", "slot", "booking_contact"],
      },
      {
        id: "subject_2",
        role: "mentioned_person",
        label: "мама",
        patient_name: "Анна",
        service: null,
        slot: null,
        booking_contact: null,
        status: "collecting",
        missing: ["service", "slot", "booking_contact"],
      },
    ],
  };
}

test("SI-10: switch_subject with canonical subject_id only is normalized and switches state", async () => {
  const modelJson = JSON.stringify({
    action: "switch_subject",
    subject_id: "subject_2",
    reply: "Переключаюсь на маму.",
  });
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => makeOutputResponse(modelJson) } },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Переключаюсь на маму.");
  assert.equal(result.final_response.subject_intent?.action, "switch_subject");
  assert.equal(result.final_response.subject_intent?.target, "mentioned_person");
  assert.equal(result.final_response.subject_intent?.subject_id, "subject_2");
  assert.equal(result.final_response.subject_intent?.confidence, "medium");

  const nextState = applySubjectIntent(makeSubjectsState(), result.final_response.subject_intent!);
  assert.equal(nextState.active_subject_id, "subject_2");
});

test("SI-11: switch_subject with invalid subject_id and no target keeps reply but emits no intent", async () => {
  const modelJson = JSON.stringify({
    action: "switch_subject",
    subject_id: "subject-two",
    reply: "Хорошо.",
  });
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => makeOutputResponse(modelJson) } },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Хорошо.");
  assert.equal(result.final_response.subject_intent, undefined);
});

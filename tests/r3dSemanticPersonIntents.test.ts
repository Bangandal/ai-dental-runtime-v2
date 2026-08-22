import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAIInput,
  createOpenAIRuntimeAgentCaller,
} from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { buildRuntimeAgentSystemInstruction } from "../src/runtime/openaiRuntimeAgent.ts";
import { parseModelPersonIntents } from "../src/runtime/modelPersonIntentBridge.ts";
import { buildModelVisiblePeopleContext } from "../src/runtime/modelPeopleContextBridge.ts";
import type { BookingSubjectsState } from "../src/runtime/bookingSubjectsState.ts";

const MODEL_CONTEXT = {
  runtime_context: {
    booking_subjects: {
      version: 3,
      status: "active",
      active_subject_id: "subject_3",
      subjects: [
        { id: "subject_1", label: "я", patient_name: "Mikhail" },
        { id: "subject_2", label: "дочь", patient_name: "Eva" },
        { id: "subject_3", label: "сын", patient_name: "Mark" },
      ],
      max_subjects: 4,
    },
  },
};

function makeCallerInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_r3d",
    system_instruction: buildRuntimeAgentSystemInstruction({
      now: new Date("2026-08-21T12:00:00Z"),
      timezone: "Europe/Prague",
    }),
    input: {
      message: "Теперь про Еву",
      context: MODEL_CONTEXT,
    },
  };
}

test("R3d canonical model instruction contains only semantic people protocol", () => {
  const instruction = makeCallerInput().system_instruction;
  assert.match(instruction, /## BOOKING PEOPLE/);
  assert.match(instruction, /person_ref/);
  assert.match(instruction, /other_person/);
  assert.doesNotMatch(instruction, /subject_1=sender\/self/);
  assert.doesNotMatch(instruction, /subject_id:null\|subject_N/);
  assert.doesNotMatch(instruction, /target_subject_id:null\|subject_N/);
});

test("R3d OpenAI payload receives canonical semantic instruction", () => {
  const payload = buildOpenAIInput(makeCallerInput() as never);
  const instructions = String(payload.instructions);
  assert.match(instructions, /## BOOKING PEOPLE/);
  assert.doesNotMatch(instructions, /subject_1=sender\/self/);
  assert.match(instructions, /Never emit subject_id/);
});

test("R3d semantic switch resolves exact visible patient name", () => {
  const parsed = parseModelPersonIntents({
    subject_intent: {
      action: "switch_subject",
      target: "other_person",
      person_ref: "  EVA  ",
      confidence: "high",
    },
  }, null, MODEL_CONTEXT);

  assert.equal(parsed.subject_intent?.target, "mentioned_person");
  assert.equal(parsed.subject_intent?.subject_id, "subject_2");
  assert.equal(parsed.subject_intent?.confidence, "high");
});

test("R3d semantic active target resolves runtime active person", () => {
  const parsed = parseModelPersonIntents({
    subject_intent: {
      action: "switch_subject",
      target: "active",
      confidence: "high",
    },
  }, null, MODEL_CONTEXT);

  assert.equal(parsed.subject_intent?.subject_id, "subject_3");
});

test("R3d semantic self target never needs a technical id from model", () => {
  const parsed = parseModelPersonIntents({
    subject_intent: {
      action: "switch_subject",
      target: "self",
      confidence: "high",
    },
  }, null, MODEL_CONTEXT);

  assert.equal(parsed.subject_intent?.target, "self");
  assert.equal(parsed.subject_intent?.subject_id, null);
});

test("R3d ambiguous other-person switch fails closed instead of choosing first", () => {
  const parsed = parseModelPersonIntents({
    subject_intent: {
      action: "switch_subject",
      target: "other_person",
      confidence: "high",
    },
  }, null, MODEL_CONTEXT);

  assert.equal(parsed.subject_intent?.target, "mentioned_person");
  assert.equal(parsed.subject_intent?.subject_id, null);
  assert.equal(parsed.subject_intent?.confidence, "low");
});

test("R3d duplicate exact person_ref fails closed", () => {
  const duplicateContext = {
    runtime_context: {
      booking_subjects: {
        active_subject_id: "subject_2",
        subjects: [
          { id: "subject_1", label: "я", patient_name: "Mikhail" },
          { id: "subject_2", label: "дочь", patient_name: "Eva" },
          { id: "subject_3", label: "вторая дочь", patient_name: "Eva" },
        ],
      },
    },
  };
  const parsed = parseModelPersonIntents({
    subject_intent: {
      action: "switch_subject",
      target: "other_person",
      person_ref: "Eva",
      confidence: "high",
    },
  }, null, duplicateContext);

  assert.equal(parsed.subject_intent?.subject_id, null);
  assert.equal(parsed.subject_intent?.confidence, "low");
});

test("R3d hallucinated legacy subject_id cannot override semantic person_ref", () => {
  const parsed = parseModelPersonIntents({
    subject_intent: {
      action: "switch_subject",
      target: "other_person",
      person_ref: "Eva",
      subject_id: "subject_4",
      confidence: "high",
    },
  }, null, MODEL_CONTEXT);

  assert.equal(parsed.subject_intent?.subject_id, "subject_2");
});

test("R3d semantic phone ownership resolves exact other person", () => {
  const parsed = parseModelPersonIntents({
    phone_ownership_intent: {
      action: "assign_pending_phone",
      target: "other_person",
      person_ref: "Mark",
      target_subject_id: "subject_4",
      confidence: "high",
    },
  }, null, MODEL_CONTEXT);

  assert.equal(parsed.phone_ownership_intent?.target_subject_id, "subject_3");
  assert.equal(parsed.phone_ownership_intent?.confidence, "high");
});

test("R3d ambiguous semantic phone ownership fails closed", () => {
  const parsed = parseModelPersonIntents({
    phone_ownership_intent: {
      action: "assign_pending_phone",
      target: "other_person",
      confidence: "high",
    },
  }, null, MODEL_CONTEXT);

  assert.equal(parsed.phone_ownership_intent?.target_subject_id, null);
  assert.equal(parsed.phone_ownership_intent?.confidence, "low");
});

test("R3d caller passes model context into semantic resolver", async () => {
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async () => ({
          final_response: {
            final_patient_reply: "Хорошо, продолжаем для Евы.",
            subject_intent: {
              action: "switch_subject",
              target: "other_person",
              person_ref: "Eva",
              confidence: "high",
            },
          },
        }),
      },
    },
  });

  const result = await caller(makeCallerInput() as never);
  assert.equal(result.type, "final_response");
  if (result.type !== "final_response") return;
  assert.equal(result.final_response.subject_intent?.subject_id, "subject_2");
});

test("R3d people projection exposes semantic hints while IDs remain transitional", () => {
  const state: BookingSubjectsState = {
    version: 3,
    status: "active",
    active_subject_id: "subject_2",
    pending_typed_phone: null,
    max_subjects: 4,
    subjects: [
      {
        id: "subject_1",
        role: "sender",
        label: "я",
        patient_name: "Mikhail",
        service: null,
        slot: null,
        booking_contact: null,
        status: "collecting",
        missing: ["service", "slot", "booking_contact"],
      },
      {
        id: "subject_2",
        role: "mentioned_person",
        label: "дочь",
        patient_name: "Eva",
        service: null,
        slot: null,
        booking_contact: null,
        status: "collecting",
        missing: ["service", "slot", "booking_contact"],
      },
    ],
  };

  const projected = buildModelVisiblePeopleContext(state) as any;
  assert.equal(projected.subjects[0].person_kind, "self");
  assert.equal(projected.subjects[0].is_active, false);
  assert.equal(projected.subjects[1].person_kind, "other_person");
  assert.equal(projected.subjects[1].is_active, true);
});

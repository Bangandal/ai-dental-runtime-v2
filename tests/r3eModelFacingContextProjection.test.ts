import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAIInput,
  createOpenAIRuntimeAgentCaller,
} from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { projectModelFacingContext } from "../src/runtime/modelFacingContextProjection.ts";

const INTERNAL_CONTEXT = {
  clinic_id: "clinic_1",
  runtime_context: {
    booking_subjects: {
      version: 3,
      status: "active",
      active_subject_id: "subject_3",
      subjects: [
        {
          id: "subject_1",
          person_kind: "self",
          is_active: false,
          label: "я",
          patient_name: "Mikhail",
          contact_owner: "self",
        },
        {
          id: "subject_2",
          person_kind: "other_person",
          is_active: false,
          label: "дочь",
          patient_name: "Eva",
          contact_owner: "subject_1",
        },
        {
          id: "subject_3",
          person_kind: "other_person",
          is_active: true,
          label: "сын",
          patient_name: "Mark",
          contact_owner: "subject_2",
        },
      ],
      max_subjects: 4,
    },
  },
};

function makeInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_r3e",
    system_instruction: "system",
    input: {
      message: "Теперь про Еву",
      context: INTERNAL_CONTEXT,
    },
  };
}

test("R3e outbound people projection removes technical person ids without mutating internal context", () => {
  const projected = projectModelFacingContext(INTERNAL_CONTEXT);
  const booking = (projected.runtime_context as any).booking_subjects;

  assert.equal(Object.prototype.hasOwnProperty.call(booking, "active_subject_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(booking.subjects[0], "id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(booking.subjects[1], "id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(booking.subjects[2], "id"), false);
  assert.equal(booking.subjects[1].contact_owner, "self");
  assert.equal(booking.subjects[2].contact_owner, "дочь");
  assert.equal(booking.subjects[2].is_active, true);
  assert.equal(booking.subjects[1].patient_name, "Eva");

  assert.equal((INTERNAL_CONTEXT.runtime_context.booking_subjects as any).active_subject_id, "subject_3");
  assert.equal((INTERNAL_CONTEXT.runtime_context.booking_subjects.subjects[1] as any).id, "subject_2");
});

test("R3e OpenAI user payload contains no subject_N values", () => {
  const openAIInput = buildOpenAIInput(makeInput() as never);
  const responseInput = openAIInput.input as Array<Record<string, any>>;
  const rawText = responseInput[0]!.content[0].text as string;
  const payload = JSON.parse(rawText);
  const serializedContext = JSON.stringify(payload.context);

  assert.doesNotMatch(serializedContext, /subject_\d+/);
  assert.equal(payload.context.runtime_context.booking_subjects.subjects[1].patient_name, "Eva");
  assert.equal(payload.context.runtime_context.booking_subjects.subjects[2].is_active, true);
});

test("R3e caller keeps private ids for deterministic semantic resolution after sanitizing outbound payload", async () => {
  let captured: Record<string, any> | null = null;
  const caller = createOpenAIRuntimeAgentCaller({
    client: {
      responses: {
        create: async (input: unknown) => {
          captured = input as Record<string, any>;
          return {
            final_response: {
              final_patient_reply: "Хорошо, продолжаем для Евы.",
              subject_intent: {
                action: "switch_subject",
                target: "other_person",
                person_ref: "Eva",
                confidence: "high",
              },
            },
          };
        },
      },
    },
  });

  const result = await caller(makeInput() as never);
  assert.equal(result.type, "final_response");
  if (result.type !== "final_response") return;
  assert.equal(result.final_response.subject_intent?.subject_id, "subject_2");

  const rawText = captured!.input[0].content[0].text as string;
  assert.doesNotMatch(rawText, /subject_\d+/);
});

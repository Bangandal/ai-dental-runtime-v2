import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIRuntimeAgentCaller } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

function makeInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_trailing_json",
    system_instruction: "system",
    input: {
      message: "Хочу записать маму",
      context: { clinic_id: "clinic_1" },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  };
}

function makeOutputResponse(text: string) {
  return {
    conversation_id: "conv_trailing_json",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  };
}

test("SI-12: JSON subject envelope plus trailing text extracts both intent and clean patient reply", async () => {
  const envelope = JSON.stringify({
    action: "create_subjects",
    labels: ["мама"],
    confidence: "high",
  });
  const trailingReply = "Напишите, пожалуйста, имя и фамилию мамы и удобное время.";
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => makeOutputResponse(`${envelope}\n\n${trailingReply}`) } },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, trailingReply);
  assert.equal(result.final_response.subject_intent?.action, "create_subjects");
  assert.equal(result.final_response.subject_intent?.target, "mentioned_person");
  assert.equal(result.final_response.subject_intent?.count, 1);
  assert.deepEqual(result.final_response.subject_intent?.labels, ["мама"]);
  assert.ok(!result.final_response.final_patient_reply.trimStart().startsWith("{"), "raw JSON must not reach the patient");
});

test("SI-13: balanced scanner handles nested objects and closing braces inside JSON strings", async () => {
  const envelope = JSON.stringify({
    action: "create_subjects",
    labels: ["мама"],
    confidence: "high",
    debug_meta: {
      note: "literal } brace and an escaped quote: \"done\"",
      nested: { depth: 2 },
    },
  });
  const trailingReply = "Как зовут маму?";
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => makeOutputResponse(`${envelope}\n${trailingReply}`) } },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, trailingReply);
  assert.equal(result.final_response.subject_intent?.action, "create_subjects");
  assert.deepEqual(result.final_response.subject_intent?.labels, ["мама"]);
});

test("SI-14: explicit envelope reply remains authoritative when extra trailing text is also present", async () => {
  const envelope = JSON.stringify({
    action: "create_subjects",
    labels: ["мама"],
    confidence: "high",
    reply: "Структурированный ответ.",
  });
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => makeOutputResponse(`${envelope}\nЛишний хвост.`) } },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Структурированный ответ.");
  assert.equal(result.final_response.subject_intent?.action, "create_subjects");
});

test("SI-15: unknown action plus trailing text keeps clean reply and emits no subject intent", async () => {
  const envelope = JSON.stringify({ action: "book_appointment" });
  const trailingReply = "Сейчас уточню детали записи.";
  const caller = createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => makeOutputResponse(`${envelope}\n\n${trailingReply}`) } },
  });

  const result = await caller(makeInput());
  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, trailingReply);
  assert.equal(result.final_response.subject_intent, undefined);
});

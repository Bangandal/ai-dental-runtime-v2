import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenAIRuntimeAgentCaller } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

function makeInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_trailing_envelope",
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
    conversation_id: "conv_trailing_envelope",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  };
}

function makeCaller(text: string) {
  return createOpenAIRuntimeAgentCaller({
    client: { responses: { create: async () => makeOutputResponse(text) } },
  });
}

test("PR177-1: JSON subject envelope plus trailing text extracts intent and sends only trailing reply", async () => {
  const modelText = `${JSON.stringify({
    action: "create_subjects",
    labels: ["мама"],
    confidence: "high",
  })}\n\nНапишите, пожалуйста, имя и фамилию мамы.`;

  const result = await makeCaller(modelText)(makeInput());

  assert.equal(result.type, "final_response");
  assert.equal(
    result.final_response.final_patient_reply,
    "Напишите, пожалуйста, имя и фамилию мамы.",
  );
  assert.equal(result.final_response.final_patient_reply.startsWith("{"), false);
  assert.equal(result.final_response.subject_intent?.action, "create_subjects");
  assert.equal(result.final_response.subject_intent?.target, "mentioned_person");
  assert.equal(result.final_response.subject_intent?.count, 1);
  assert.deepEqual(result.final_response.subject_intent?.labels, ["мама"]);
});

test("PR177-2: balanced scanner handles nested objects, braces in strings, and escaped quotes", async () => {
  const envelope = {
    action: "create_subjects",
    labels: ["мама"],
    confidence: "high",
    debug: {
      nested: { depth: 2 },
      text: "literal { brace } and an escaped \"quote\"",
    },
  };
  const modelText = `${JSON.stringify(envelope)}\n\nКак зовут маму?`;

  const result = await makeCaller(modelText)(makeInput());

  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Как зовут маму?");
  assert.equal(result.final_response.subject_intent?.action, "create_subjects");
  assert.deepEqual(result.final_response.subject_intent?.labels, ["мама"]);
});

test("PR177-3: explicit reply field remains authoritative when trailing text also exists", async () => {
  const modelText = `${JSON.stringify({
    action: "create_subjects",
    labels: ["мама"],
    confidence: "high",
    reply: "Напишите имя мамы.",
  })}\n\nЭтот хвост не должен переопределять explicit reply.`;

  const result = await makeCaller(modelText)(makeInput());

  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Напишите имя мамы.");
  assert.equal(result.final_response.subject_intent?.action, "create_subjects");
});

test("PR177-4: unknown action plus trailing text preserves clean reply and emits no subject_intent", async () => {
  const modelText = `${JSON.stringify({ action: "unexpected_action" })}\n\nПродолжим уточнение.`;

  const result = await makeCaller(modelText)(makeInput());

  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Продолжим уточнение.");
  assert.equal(result.final_response.subject_intent, undefined);
});

test("PR177-5: pure JSON envelope behavior remains unchanged", async () => {
  const modelText = JSON.stringify({
    action: "create_subjects",
    labels: ["мама"],
    confidence: "high",
    reply: "Как зовут маму?",
  });

  const result = await makeCaller(modelText)(makeInput());

  assert.equal(result.type, "final_response");
  assert.equal(result.final_response.final_patient_reply, "Как зовут маму?");
  assert.equal(result.final_response.subject_intent?.action, "create_subjects");
});

test("PR177-6: merge RPC explicitly persists booking_subjects without clearing it when absent", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(thisDir, "../sql/rpc/core.rpc_merge_conversation_state.sql");
  const source = await readFile(sqlPath, "utf8");

  assert.match(
    source,
    /jsonb_typeof\(v_control_flags->'booking_subjects'\)\s*=\s*'object'/,
    "RPC must accept booking_subjects only as an object",
  );
  assert.match(
    source,
    /jsonb_set\(\s*v_next_state,\s*'\{booking_subjects\}',\s*v_control_flags->'booking_subjects',\s*true\s*\)/s,
    "RPC must atomically replace the canonical booking_subjects snapshot",
  );
});

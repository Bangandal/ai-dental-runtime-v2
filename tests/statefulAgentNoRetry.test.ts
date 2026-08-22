import assert from "node:assert/strict";
import test from "node:test";

import {
  createDentalRuntimeAgent,
  createStatefulAgentResponsesClient,
} from "../src/runtime/dentalRuntimeAgentFactory.ts";
import type { OpenAIResponsesClient } from "../src/runtime/openaiRuntimeAgentCaller.ts";

test("stateful dental agent forces maxRetries=0 on responses.create", async () => {
  const seen: Array<{ input: unknown; options: Record<string, unknown> | undefined }> = [];
  const rawClient = {
    responses: {
      async create(input: unknown, options?: Record<string, unknown>) {
        seen.push({ input, options });
        return { output_text: "ok" };
      },
    },
  } as OpenAIResponsesClient;

  const client = createStatefulAgentResponsesClient(rawClient);
  await client.responses.create({ model: "gpt-test", conversation: "conv_1" });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.input, { model: "gpt-test", conversation: "conv_1" });
  assert.equal(seen[0]?.options?.maxRetries, 0);
});

test("stateful retry wrapper preserves the original responses resource as this", async () => {
  let originalThis: unknown;
  const responses = {
    marker: "original-resource",
    async create(this: unknown) {
      originalThis = this;
      return { output_text: "ok" };
    },
  };
  const rawClient = { responses } as unknown as OpenAIResponsesClient;

  const client = createStatefulAgentResponsesClient(rawClient);
  await client.responses.create({});

  assert.equal(originalThis, responses);
});

test("createDentalRuntimeAgent wires the no-retry client into the real model caller", async () => {
  const seenOptions: Array<Record<string, unknown> | undefined> = [];
  const openaiClient = {
    responses: {
      async create(_input: unknown, options?: Record<string, unknown>) {
        seenOptions.push(options);
        return { output_text: "Done", conversation_id: "conv_1" };
      },
    },
  } as OpenAIResponsesClient;

  const agent = createDentalRuntimeAgent({
    model: "gpt-test",
    openaiClient,
    rpc: async () => ({ data: null, error: null }),
    embeddingClient: { createEmbedding: async () => [0.1] },
    embeddingModel: "text-embedding-3-small",
  });

  const result = await agent.runTurn({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    conversation_id: "conv_1",
    user_message: "Hello",
    locale: "en",
  });

  assert.equal(result.final_patient_reply, "Done");
  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0]?.maxRetries, 0);
});

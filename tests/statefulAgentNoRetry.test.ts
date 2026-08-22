import assert from "node:assert/strict";
import test from "node:test";

import { createStatefulAgentResponsesClient } from "../src/runtime/dentalRuntimeAgentFactory.ts";
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

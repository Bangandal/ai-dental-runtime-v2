import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapRuntimeServer, readRuntimeServerEnv } from "../src/index.ts";
const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";

test("bootstrapRuntimeServer registers POST /runtime/turn via RuntimeTurnService stack", async () => {
  const responseCalls: unknown[] = [];
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;

  bootstrapRuntimeServer({
    app: {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    env: { runtimeModel: "gpt-entrypoint-test", runtimeEmbeddingModel: "text-embedding-3-small" },
    openaiClient: {
      responses: {
        async create(payload) {
          responseCalls.push(payload);
          return { output_text: "Принято" };
        },
      },
    },
    rpc: async (fn) => fn === "rpc_resolve_clinic_identity_v1"
        ? { data: [{ clinic_id: CLINIC_UUID, clinic_code: "clinic_1" }], error: null }
        : { data: [], error: null },
    embeddingClient: { createEmbedding: async () => [0.1] },
  });

  assert.ok(handler);

  let payload: any;
  const reply = {
    code() {
      return reply;
    },
    send(nextPayload: unknown) {
      payload = nextPayload;
    },
  };

  await handler!(
    {
      body: {
        clinic_code: CLINIC_UUID,
        channel: "telegram",
        external_user_id: "user_1",
        text: "Здравствуйте",
      },
    },
    reply,
  );

  assert.equal(payload.reply_text, "Принято");
  assert.deepEqual(payload.side_effects, []);
  assert.equal(responseCalls.length >= 1, true);
  assert.equal((responseCalls[0] as Record<string, unknown>).model, "gpt-entrypoint-test");
});

test("readRuntimeServerEnv keeps model wiring from process env", () => {
  const explicit = readRuntimeServerEnv({ RUNTIME_OPENAI_MODEL: "gpt-4.1", RUNTIME_EMBEDDING_MODEL: "text-embedding-3-large" });
  assert.equal(explicit.runtimeModel, "gpt-4.1");
  assert.equal(explicit.runtimeEmbeddingModel, "text-embedding-3-large");

  const fallback = readRuntimeServerEnv({});
  assert.equal(fallback.runtimeModel, "gpt-4.1-mini");
  assert.equal(fallback.runtimeEmbeddingModel, "text-embedding-3-small");
});

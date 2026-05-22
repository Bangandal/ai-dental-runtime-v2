import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapRuntimeServer, readRuntimeServerEnv } from "../src/server.ts";

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
    env: { runtimeModel: "gpt-entrypoint-test" },
    openaiClient: {
      responses: {
        async create(payload) {
          responseCalls.push(payload);
          return { output_text: "Принято" };
        },
      },
    },
    rpc: async () => ({ data: [], error: null }),
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
        clinic_code: "clinic_a",
        channel: "telegram",
        external_user_id: "user_1",
        text: "Здравствуйте",
      },
    },
    reply,
  );

  assert.equal(payload.reply_text, "Принято");
  assert.deepEqual(payload.side_effects, []);
  assert.equal(responseCalls.length, 1);
  assert.equal((responseCalls[0] as Record<string, unknown>).model, "gpt-entrypoint-test");
});

test("readRuntimeServerEnv keeps model wiring from process env", () => {
  const explicit = readRuntimeServerEnv({ RUNTIME_OPENAI_MODEL: "gpt-4.1" });
  assert.equal(explicit.runtimeModel, "gpt-4.1");

  const fallback = readRuntimeServerEnv({});
  assert.equal(fallback.runtimeModel, "gpt-4.1-mini");
});

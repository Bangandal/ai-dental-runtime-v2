import assert from "node:assert/strict";
import test from "node:test";

test("buildRuntimeApp registers /health", async (t) => {
  let buildRuntimeApp: (typeof import("../src/main.ts"))["buildRuntimeApp"];
  try {
    ({ buildRuntimeApp } = await import("../src/main.ts"));
  } catch (error) {
    if (error instanceof Error && /Cannot find package 'fastify'/.test(error.message)) {
      t.skip("fastify dependency not installed in this environment");
      return;
    }
    throw error;
  }

  const app = buildRuntimeApp({
    model: "gpt-test",
    openaiClient: { responses: { async create() { return { output_text: "ok" }; } } } as any,
    rpc: async () => ({ data: [], error: null }),
    embeddingClient: { createEmbedding: async () => [0.1] },
    embeddingModel: "text-embedding-3-small",
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});

test("buildRuntimeApp registers /runtime/turn", async (t) => {
  let buildRuntimeApp: (typeof import("../src/main.ts"))["buildRuntimeApp"];
  try {
    ({ buildRuntimeApp } = await import("../src/main.ts"));
  } catch (error) {
    if (error instanceof Error && /Cannot find package 'fastify'/.test(error.message)) {
      t.skip("fastify dependency not installed in this environment");
      return;
    }
    throw error;
  }

  const app = buildRuntimeApp({
    model: "gpt-test",
    openaiClient: { responses: { async create() { return { output_text: "Здравствуйте" }; } } } as any,
    rpc: async () => ({ data: [], error: null }),
    embeddingClient: { createEmbedding: async () => [0.1] },
    embeddingModel: "text-embedding-3-small",
  });

  const response = await app.inject({
    method: "POST",
    url: "/runtime/turn",
    payload: {
      clinic_code: "11111111-1111-4111-8111-111111111111",
      channel: "telegram",
      external_user_id: "u1",
      text: "Привет",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as { reply_text: string };
  assert.equal(body.reply_text, "Здравствуйте");
  await app.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRuntimeRoutes } from "../src/runtime/runtimeServerBootstrap.ts";
const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";

test("registerRuntimeRoutes wires /runtime/turn to RuntimeTurnService built via createDentalRuntimeTurnService", async () => {
  const responseCalls: unknown[] = [];
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;

  registerRuntimeRoutes(
    {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    {
      model: "gpt-test",
      openaiClient: {
        responses: {
          async create(payload) {
            responseCalls.push(payload);
            return { output_text: "Здравствуйте!" };
          },
        },
      },
      rpc: async (fn) => fn === "rpc_resolve_clinic_identity_v1"
        ? { data: [{ clinic_id: CLINIC_UUID, clinic_code: "clinic_1" }], error: null }
        : { data: [], error: null },
      embeddingClient: { createEmbedding: async () => [0.1] },
      embeddingModel: "text-embedding-3-small",
    },
  );

  assert.ok(handler);

  let payload: unknown;
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
        text: "Привет",
      },
    },
    reply,
  );

  const transportPayload = payload as Record<string, any>;
  assert.equal(transportPayload.reply_text, "Здравствуйте!");
  assert.deepEqual(transportPayload.side_effects, []);
  assert.equal(responseCalls.length >= 1, true);
});

test("runtime bootstrap module does not keep legacy runtime wiring references", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/runtimeServerBootstrap.ts");
  const source = await readFile(modulePath, "utf8");

  assert.match(source, /registerRuntimeTurnRoute/);
  assert.match(source, /createDentalRuntimeTurnService/);
  assert.doesNotMatch(source, /registerOldRuntimeTurnRoute|legacyRuntime|runtimeTurnPipeline/i);
});


test("registerRuntimeRoutes wires createOpenAIConversation and first turn uses created conversation", async () => {
  const responseCalls: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let createCalls = 0;
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;

  registerRuntimeRoutes(
    {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    {
      model: "gpt-test",
      openaiClient: {
        conversations: {
          async create() {
            createCalls += 1;
            return { id: "conv_created_1" };
          },
        },
        responses: {
          async create(payload) {
            responseCalls.push(payload as Record<string, unknown>);
            return { output_text: "Здравствуйте!", conversation_id: null };
          },
        },
      } as any,
      rpc: async (fn, args) => {
        rpcCalls.push({ fn, args: args as Record<string, unknown> });
        if (fn === "rpc_resolve_clinic_identity_v1") return { data: [{ clinic_id: CLINIC_UUID, clinic_code: "clinic_1" }], error: null };
        if (fn === "rpc_get_openai_conversation_memory_v1") return { data: [], error: null };
        if (fn === "rpc_upsert_openai_conversation_memory_v1") return { data: [{ conversation_id: "conv_created_1" }], error: null };
        return { data: [], error: null };
      },
      embeddingClient: { createEmbedding: async () => [0.1] },
      embeddingModel: "text-embedding-3-small",
    },
  );

  assert.ok(handler);

  let payload: unknown;
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
        text: "Привет",
      },
    },
    reply,
  );

  assert.equal((payload as Record<string, unknown>).reply_text, "Здравствуйте!");
  assert.equal(createCalls, 1);
  assert.equal(responseCalls.length >= 1, true);
  assert.equal(responseCalls.some((call) => call.conversation === "conv_created_1"), true);
  assert.equal(rpcCalls.some((c) => c.fn === "rpc_get_openai_conversation_memory_v1"), true);
  assert.equal(rpcCalls.some((c) => c.fn === "rpc_upsert_openai_conversation_memory_v1"), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeTurnRoute } from "../src/runtime/runtimeTurnHttpRoute.ts";
import { createFileRuntimeTurnLogger, createNoopRuntimeTurnLogger } from "../src/runtime/runtimeTurnLogger.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";

const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";

function createRouteHarness(service: RuntimeTurnService, logger = createNoopRuntimeTurnLogger()) {
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;
  registerRuntimeTurnRoute(
    {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    { runtimeTurnService: service, runtimeTurnLogger: logger },
  );

  assert.ok(handler);

  async function invoke(body: Record<string, unknown>) {
    let statusCode = 200;
    let payload: unknown;
    const reply = {
      code(nextCode: number) {
        statusCode = nextCode;
        return reply;
      },
      send(nextPayload: unknown) {
        payload = nextPayload;
      },
    };

    await handler!({ body }, reply);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { statusCode, payload };
  }

  return { invoke };
}

test("successful /runtime/turn writes one JSONL event", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "runtime-turn-ok-"));
  const harness = createRouteHarness(
    {
      async runTurn() {
        return { final_patient_reply: "Здравствуйте!", conversation_id: "conv_22", tool_results: [{ ok: true }] } as any;
      },
    },
    createFileRuntimeTurnLogger({ logDir }),
  );

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
    chat_id: "chat_1",
    text: "Привет",
    meta: { language_code: "ru" },
  });
  assert.equal(response.statusCode, 200);

  const lines = (await readFile(join(logDir, "runtime-turns.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(event.status, "ok");
  assert.equal(event.channel, "telegram");
  assert.equal(event.input_text, "Привет");
});

test("validation error writes one error JSONL event", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "runtime-turn-validation-"));
  const harness = createRouteHarness({ runTurn: async () => ({}) as any }, createFileRuntimeTurnLogger({ logDir }));
  const response = await harness.invoke({ channel: "telegram" });
  assert.equal(response.statusCode, 400);

  const lines = (await readFile(join(logDir, "runtime-errors.jsonl"), "utf8")).trim().split("\n");
  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(event.status, "validation_error");
  assert.equal(event.error_code, "invalid_runtime_turn_request");
});

test("service exception writes error JSONL and route returns fallback", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "runtime-turn-exception-"));
  const harness = createRouteHarness(
    { runTurn: async () => { throw new Error("runtime exploded"); } },
    createFileRuntimeTurnLogger({ logDir }),
  );
  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", chat_id: "chat_1", text: "Помогите" });
  assert.equal(response.statusCode, 200);
  const payload = response.payload as Record<string, any>;
  assert.equal(payload.reply_text.includes("Извините"), true);

  const lines = (await readFile(join(logDir, "runtime-errors.jsonl"), "utf8")).trim().split("\n");
  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(event.status, "runtime_error");
  assert.equal(event.fallback_reply, payload.final_patient_reply);
});

test("logger failure does not break route", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", tool_results: [] }) as any },
    { logTurn: async () => { throw new Error("log failed"); }, logError: async () => {} },
  );
  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", chat_id: "chat_1", text: "hi" });
  assert.equal(response.statusCode, 200);
});

test("jsonl lines are valid JSON and do not contain secret env values", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "runtime-turn-secrets-"));
  process.env.OPENAI_API_KEY = "sk-secret-openai";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb-secret-role";

  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", tool_results: [{ a: 1 }] }) as any },
    createFileRuntimeTurnLogger({ logDir }),
  );
  await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "hello" });

  const raw = await readFile(join(logDir, "runtime-turns.jsonl"), "utf8");
  for (const line of raw.trim().split("\n")) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.equal(raw.includes("sk-secret-openai"), false);
  assert.equal(raw.includes("sb-secret-role"), false);
});

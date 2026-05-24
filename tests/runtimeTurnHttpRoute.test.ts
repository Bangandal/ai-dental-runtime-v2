import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { registerRuntimeTurnRoute } from "../src/runtime/runtimeTurnHttpRoute.ts";
import { createFileRuntimeTurnLogger, createNoopRuntimeTurnLogger } from "../src/runtime/runtimeTurnLogger.ts";
import type { RuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { OpenAIConversationMemoryRepository } from "../src/runtime/supabaseOpenAIConversationMemoryRepository.ts";
import type { TurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";

const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";

function createRouteHarness(
  service: RuntimeTurnService,
  logger = createNoopRuntimeTurnLogger(),
  openAIConversationMemoryRepository?: OpenAIConversationMemoryRepository,
  createOpenAIConversation?: () => Promise<string | null>,
  turnPersistenceRepository?: TurnPersistenceRepository,
) {
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;
  registerRuntimeTurnRoute(
    {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    { runtimeTurnService: service, runtimeTurnLogger: logger, openAIConversationMemoryRepository, createOpenAIConversation, turnPersistenceRepository },
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    return { statusCode, payload };
  }

  return { invoke };
}

test("valid payload maps RuntimeTurnInput and returns n8n-compatible reply", async () => {
  const calls: unknown[] = [];
  const harness = createRouteHarness({
    async runTurn(input) {
      calls.push(input);
      return {
        final_patient_reply: "Здравствуйте!",
        conversation_id: "conv_22",
        tool_requests: [],
        tool_results: [{ tool: "kb.search", status: "success" }],
      } as any;
    },
  });

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
    chat_id: "chat_1",
    text: "Привет",
    meta: { language_code: "ru" },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.payload as Record<string, any>;
  assert.equal(payload.reply_text, "Здравствуйте!");
  assert.equal(payload.final_patient_reply, "Здравствуйте!");
  assert.equal(payload.side_effects.length, 0);
  assert.equal(typeof payload.trace_id, "string");

  const input = calls[0] as Record<string, any>;
  assert.equal(input.clinic_id, CLINIC_UUID);
  assert.equal(input.contact_id, "telegram:user_1");
  assert.equal(input.case_id, null);
  assert.equal(input.user_message, "Привет");
  assert.equal(input.locale, "ru");
});

test("invalid request returns 400", async () => {
  const harness = createRouteHarness({
    runTurn: async () => {
      throw new Error("should not run");
    },
  });

  const missingText = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
  });
  assert.equal(missingText.statusCode, 400);

  const missingClinic = await harness.invoke({
    channel: "telegram",
    external_user_id: "user_1",
    text: "hi",
  });
  assert.equal(missingClinic.statusCode, 400);

  const invalidClinicCode = await harness.invoke({
    clinic_code: "clinic_1",
    channel: "telegram",
    external_user_id: "user_1",
    text: "hi",
  });
  assert.equal(invalidClinicCode.statusCode, 400);
});

test("service failure returns safe fallback and admin_notification side effect", async () => {
  const harness = createRouteHarness({
    runTurn: async () => {
      throw new Error("runtime exploded");
    },
  });

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    chat_id: "chat_1",
    text: "Помогите",
  });

  assert.equal(response.statusCode, 200);
  const payload = response.payload as Record<string, any>;
  assert.equal(payload.reply_text.includes("Извините"), true);
  assert.equal(payload.side_effects[0].type, "admin_notification");
  assert.equal(payload.debug.runtime_error, "runtime exploded");
});

test("request does not require conversation_id from n8n", async () => {
  const calls: unknown[] = [];
  const harness = createRouteHarness({
    async runTurn(input) {
      calls.push(input);
      return {
        final_patient_reply: "ok",
        conversation_id: "conv_55",
        tool_requests: [],
        tool_results: [],
      } as any;
    },
  });

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    chat_id: "chat_1",
    text: "Hello",
  });

  assert.equal((calls[0] as Record<string, unknown>).conversation_id, undefined);
  assert.equal((response.payload as Record<string, unknown>).conversation_id, "conv_55");
});

test("route module keeps transport/business boundaries", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/runtimeTurnHttpRoute.ts");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
  assert.doesNotMatch(source, /booking\./i);
  assert.match(source, /runtimeTurnService\.runTurn/);
});

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
    {
      runTurn: async () => {
        throw new Error("runtime exploded");
      },
    },
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


test("no memory creates conversation_id and passes it into service", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const memorySaves: string[] = [];
  let creates = 0;

  const harness = createRouteHarness(
    {
      async runTurn(input) {
        calls.push(input as Record<string, unknown>);
        return { final_patient_reply: "ok", conversation_id: null, tool_results: [] } as any;
      },
    },
    createNoopRuntimeTurnLogger(),
    {
      async getConversationMemory() {
        return { ok: true, data: { conversation_id: null } };
      },
      async saveConversationMemory(input) {
        memorySaves.push(input.conversation_id);
        return { ok: true, data: { conversation_id: input.conversation_id } };
      },
    },
    async () => {
      creates += 1;
      return "conv_created_1";
    },
  );

  const response = await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
    chat_id: "chat_1",
    text: "hi",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls[0]?.conversation_id, "conv_created_1");
  assert.deepEqual(memorySaves, ["conv_created_1"]);
  assert.equal(creates, 1);
});

test("second turn with memory passes conversation_id into service", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const harness = createRouteHarness(
    {
      async runTurn(input) {
        calls.push(input as Record<string, unknown>);
        return { final_patient_reply: "ok", conversation_id: "conv_mem_1", tool_results: [] } as any;
      },
    },
    createNoopRuntimeTurnLogger(),
    {
      async getConversationMemory() {
        return { ok: true, data: { conversation_id: "conv_mem_1" } };
      },
      async saveConversationMemory(input) {
        return { ok: true, data: { conversation_id: input.conversation_id } };
      },
    },
  );

  await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
    text: "hi",
  });

  assert.equal(calls[0]?.conversation_id, "conv_mem_1");
});

test("memory get failure is non-fatal", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", conversation_id: "conv_x", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    {
      async getConversationMemory() {
        throw new Error("load failed");
      },
      async saveConversationMemory(input) {
        return { ok: true, data: { conversation_id: input.conversation_id } };
      },
    },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", chat_id: "chat_1", text: "hi" });
  assert.equal(response.statusCode, 200);
});

test("memory save failure is non-fatal", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", conversation_id: "conv_x", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    {
      async getConversationMemory() {
        return { ok: true, data: { conversation_id: null } };
      },
      async saveConversationMemory() {
        throw new Error("save failed");
      },
    },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", chat_id: "chat_1", text: "hi" });
  assert.equal(response.statusCode, 200);
});


test("existing memory does not create new conversation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let creates = 0;

  const harness = createRouteHarness(
    {
      async runTurn(input) {
        calls.push(input as Record<string, unknown>);
        return { final_patient_reply: "ok", conversation_id: "conv_mem_1", tool_results: [] } as any;
      },
    },
    createNoopRuntimeTurnLogger(),
    {
      async getConversationMemory() {
        return { ok: true, data: { conversation_id: "conv_mem_1" } };
      },
      async saveConversationMemory(input) {
        return { ok: true, data: { conversation_id: input.conversation_id } };
      },
    },
    async () => {
      creates += 1;
      return "conv_created_should_not_happen";
    },
  );

  await harness.invoke({
    clinic_code: CLINIC_UUID,
    channel: "telegram",
    external_user_id: "user_1",
    text: "hi",
  });

  assert.equal(calls[0]?.conversation_id, "conv_mem_1");
  assert.equal(creates, 0);
});

test("route persists pre/post turn artifacts and keeps response contract", async () => {
  const calls: string[] = [];
  const persistenceRepo: TurnPersistenceRepository = {
    async getOrCreateContact() { calls.push("contact"); return { ok: true, data: { contact_id: "c1" } }; },
    async registerInboundEvent() { calls.push("inbound"); return { ok: true, data: {} }; },
    async saveMessage(input) { calls.push(`msg:${input.role}`); return { ok: true, data: {} }; },
    async mergeConversationState(input) { calls.push("merge"); assert.equal(input.patch.last_bot_question, "Question?"); return { ok: true, data: { ok: true } }; },
  };

  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "Question?", tool_results: [], debug: { last_intent: "faq" } }) as any },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    persistenceRepo,
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", chat_id: "chat_1", text: "hi" });
  const payload = response.payload as Record<string, any>;

  assert.deepEqual(calls, ["contact", "inbound", "msg:user", "msg:assistant", "merge"]);
  assert.equal(payload.reply_text, "Question?");
  assert.equal(payload.final_patient_reply, "Question?");
  assert.equal(payload.side_effects.length, 0);
  assert.deepEqual(payload.debug.persistence_debug.merge_state, { ok: true });
});

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
import type { ClinicIdentityResolver } from "../src/runtime/supabaseClinicIdentityResolver.ts";
import type { RuntimeGateClassifier } from "../src/runtime/runtimeGateShadow.ts";
import type { TurnUnderstandingClassifier } from "../src/runtime/turnUnderstandingShadow.ts";

const CLINIC_UUID = "11111111-1111-4111-8111-111111111111";
const CLINIC_CODE = "clinic_1";

const defaultClinicIdentityResolver: ClinicIdentityResolver = {
  async resolveClinicIdentity(input) {
    if (input.clinic_identifier === CLINIC_UUID || input.clinic_identifier === CLINIC_CODE) {
      return { ok: true, data: { clinic_id: CLINIC_UUID, clinic_code: CLINIC_CODE } };
    }
    return { ok: false, error: { code: "clinic_not_found", message: "missing", retryable: false } };
  },
};

function createRouteHarness(
  service: RuntimeTurnService,
  logger = createNoopRuntimeTurnLogger(),
  openAIConversationMemoryRepository?: OpenAIConversationMemoryRepository,
  createOpenAIConversation?: () => Promise<string | null>,
  turnPersistenceRepository?: TurnPersistenceRepository,
  clinicIdentityResolver: ClinicIdentityResolver = defaultClinicIdentityResolver,
  runtimeContextRepository?: { loadRuntimeContext(input: { clinic_id: string; contact_id: string }): Promise<any> },
  caseContextRepository?: { loadCaseContext(input: { clinic_id: string; contact_id: string }): Promise<any> },
  runtimeGateClassifier?: RuntimeGateClassifier,
  turnUnderstandingClassifier?: TurnUnderstandingClassifier,
) {
  let handler: ((request: { body: any }, reply: any) => Promise<void>) | undefined;
  registerRuntimeTurnRoute(
    {
      post(path, routeHandler) {
        assert.equal(path, "/runtime/turn");
        handler = routeHandler;
      },
    },
    { runtimeTurnService: service, runtimeTurnLogger: logger, openAIConversationMemoryRepository, createOpenAIConversation, turnPersistenceRepository, clinicIdentityResolver, runtimeContextRepository, caseContextRepository, runtimeGateClassifier, turnUnderstandingClassifier },
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
  assert.equal(payload.debug.runtime_gate.mode, "shadow");
  assert.equal(payload.debug.runtime_gate.route, "non_operational");
  assert.equal(payload.debug.runtime_gate.should_apply, false);
  assert.equal(payload.debug.legacy_case_router.mode, "shadow");
  assert.equal(payload.debug.legacy_case_router.decision.should_apply, false);

  const input = calls[0] as Record<string, any>;
  assert.equal(input.clinic_id, CLINIC_UUID);
  assert.equal(input.contact_id, "telegram:user_1");
  assert.equal(input.case_id, null);
  assert.equal(input.user_message, "Привет");
  assert.equal(input.locale, "ru");
});

test("debug.runtime_gate appears in runtime response and log payload without changing reply", async () => {
  let loggedDebug: Record<string, any> | null = null;
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "same reply", tool_results: [], debug: { existing: true } }) as any },
    {
      async logTurn(input) { loggedDebug = input.debug as Record<string, any>; },
      async logError() {},
    },
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    undefined,
    undefined,
    {
      async classifyRuntimeGateTurn() {
        return { route: "operational_candidate", turn_shape: "booking", confidence: "high", reason: "User asks to book.", should_apply: false };
      },
    },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "Хочу записаться" });
  const payload = response.payload as Record<string, any>;

  assert.equal(response.statusCode, 200);
  assert.equal(payload.final_patient_reply, "same reply");
  assert.equal(payload.debug.existing, true);
  assert.equal(payload.debug.runtime_gate.route, "operational_candidate");
  assert.equal(payload.debug.runtime_gate.turn_shape, "booking");
  assert.equal(payload.debug.runtime_gate.should_apply, false);
  assert.equal(payload.debug.legacy_case_router.mode, "shadow");
  assert.equal(loggedDebug?.runtime_gate.route, "operational_candidate");
  assert.equal(loggedDebug?.legacy_case_router.mode, "shadow");
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

});


test("accepts short clinic_code and resolves clinic identity", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const harness = createRouteHarness({
    async runTurn(input) {
      calls.push(input as Record<string, unknown>);
      return { final_patient_reply: "ok", tool_results: [] } as any;
    },
  });

  const response = await harness.invoke({ clinic_code: CLINIC_CODE, channel: "telegram", external_user_id: "user_1", text: "hi" });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0]?.clinic_id, CLINIC_UUID);
});

test("rejects unknown clinic identifier", async () => {
  const harness = createRouteHarness({ runTurn: async () => ({ final_patient_reply: "ok", tool_results: [] }) as any });
  const response = await harness.invoke({ clinic_code: "unknown_clinic", channel: "telegram", external_user_id: "user_1", text: "hi" });
  assert.equal(response.statusCode, 400);
  assert.equal((response.payload as any).error.message, "unknown clinic");
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
    async getOrCreateContact(input) { calls.push("contact"); assert.equal(input.clinic_code, CLINIC_CODE); return { ok: true, data: { contact_id: "c1", clinic_id: CLINIC_UUID } }; },
    async registerInboundEvent(input) { calls.push("inbound"); assert.equal(typeof input.dedupe_key, "string"); return { ok: true, data: {} }; },
    async saveMessage(input) { calls.push(`msg:${input.role}:${input.direction}`); return { ok: true, data: { message_id: input.role === "user" ? "m_user_1" : "m_assistant_1" } }; },
    async mergeConversationState(input) { calls.push("merge"); assert.equal(input.user_text, "hi"); assert.equal(input.reply_text, "Question?"); return { ok: true, data: { ok: true } }; },
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

  assert.deepEqual(calls, ["contact", "inbound", "msg:user:inbound", "msg:assistant:outbound", "merge"]);
  assert.equal(payload.reply_text, "Question?");
  assert.equal(payload.final_patient_reply, "Question?");
  assert.equal(payload.side_effects.length, 0);
  assert.deepEqual(payload.debug.persistence_debug.merge_state, { ok: true });
});


test("runtime context load success hydrates runtime_context and logs debug fields", async () => {
  const calls: Array<Record<string, any>> = [];
  const runtimeGateInputs: Array<Record<string, any>> = [];
  const harness = createRouteHarness(
    {
      async runTurn(input) {
        calls.push(input as Record<string, any>);
        return { final_patient_reply: "ok", tool_results: [], debug: {} } as any;
      },
    },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    {
      async loadRuntimeContext() {
        return {
          ok: true,
          data: {
            clinic_id: CLINIC_UUID,
            contact_id: "contact_1",
            chat_id: "chat_1",
            external_user_id: "external_1",
            known_contact: { contact_id: "contact_1", clinic_id: CLINIC_UUID, first_name: "Ada", last_name: "Lovelace", username: "ada_raw", language_code: "ru", meta: { foo: "bar" } },
            conversation_state: { state_version: 7, intent: "faq", collected: { problem: "pain", phone_required: true, contact_channel_available: true }, missing_fields: ["phone"], last_user_message_text: "raw", last_bot_question: "q", last_bot_action: "a", pending_slots: ["preferred_time", 4, ""] },
            runtime_flags: { has_durable_context: true, context_source: "supabase", context_loaded_at: "2026-01-01T00:00:00.000Z" },
            recent_history: [],
          },
        };
      },
    },
    undefined,
    {
      async classifyRuntimeGateTurn(input) {
        runtimeGateInputs.push(input.runtime_context as Record<string, any>);
        return { route: "non_operational", turn_shape: "faq", confidence: "medium", reason: "debug only", should_apply: false };
      },
    },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "hello" });
  assert.equal(response.statusCode, 200);
  const input = calls[0];
  const runtimeContext = input.business_context?.runtime_context;
  assert.ok(runtimeContext);
  assert.equal(runtimeContext.patient_context.display_name, "Ada Lovelace");
  assert.equal(runtimeContext.patient_context.preferred_language, "ru");
  assert.equal(runtimeContext.task_state.last_known_intent, "faq");
  assert.equal(runtimeContext.task_state.collected.problem, "pain");
  assert.equal(runtimeContext.runtime_policy.phone_required, false);
  assert.deepEqual(runtimeContext.task_state.missing_fields, []);
  assert.deepEqual(runtimeContext.recent_history, []);
  assert.equal(runtimeContext.case_context, undefined);
  assert.equal(runtimeContext.clinic_id, undefined);
  assert.equal(runtimeContext.contact_id, undefined);
  assert.equal(runtimeContext.chat_id, undefined);
  assert.equal(runtimeContext.external_user_id, undefined);
  assert.equal(runtimeContext.state_version, undefined);
  assert.equal(runtimeContext.last_user_message_text, undefined);
  assert.equal(runtimeContext.last_bot_question, undefined);
  assert.equal(runtimeContext.last_bot_action, undefined);
  assert.equal(runtimeContext.pending_slots, undefined);
  assert.equal(runtimeContext.task_state.last_bot_question, undefined);
  assert.equal(runtimeContext.task_state.last_bot_action, undefined);
  assert.equal(runtimeContext.task_state.pending_slots, undefined);

  assert.equal(runtimeGateInputs[0]?.task_state.last_bot_question, "q");
  assert.equal(runtimeGateInputs[0]?.task_state.last_bot_action, "a");
  assert.deepEqual(runtimeGateInputs[0]?.task_state.pending_slots, ["preferred_time"]);

  const debug = (response.payload as any).debug.runtime_context;
  assert.equal(debug.loaded, true);
  assert.equal(debug.source, "supabase");
  assert.equal(debug.state_version, 7);
  assert.equal(debug.recent_history_count, 0);
});

test("runtime context load failure is non-fatal and still replies", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    {
      async loadRuntimeContext() {
        return { ok: false, error: { code: "runtime_context_load_failed", message: "rpc failed", retryable: true } };
      },
    },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "hello" });
  assert.equal(response.statusCode, 200);
  const debug = (response.payload as any).debug.runtime_context;
  assert.equal(debug.loaded, false);
  assert.equal(debug.source, "supabase");
  assert.equal(debug.error.code, "runtime_context_load_failed");
});


test("case context load success hydrates slim case/booking context and debug", async () => {
  const calls: Array<Record<string, any>> = [];
  const harness = createRouteHarness(
    { async runTurn(input) { calls.push(input as any); return { final_patient_reply: "ok", tool_results: [] } as any; } },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    { async loadRuntimeContext() { return { ok: true, data: { known_contact: {}, conversation_state: { collected: {}, missing_fields: [] }, runtime_flags: { has_durable_context: true, context_source: "supabase", context_loaded_at: "2026-01-01T00:00:00.000Z" }, recent_history: [] } }; } },
    { async loadCaseContext() { return { ok: true, data: { current_case_id: "case_2", open_cases: [{ case_id: "case_1", case_type: "faq", topic: "insurance", status: "open", priority: "low" }, { case_id: "case_2", case_type: "booking", topic: "crown", status: "open", priority: "high" }], recent_cases: [{ case_id: "case_7", case_type: "faq", topic: "insurance", status: "closed", priority: null }], active_booking_context: { active_hold: { service_interest: "cleaning", label: "Mon 9am", status: "active" }, latest_appointment: { service_interest: "exam", status: "booked", start_at: "2026-06-01T09:00:00Z" } } } }; } },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "hello" });
  assert.equal(response.statusCode, 200);
  const runtimeContext = calls[0].business_context.runtime_context;
  assert.equal(runtimeContext.case_context.has_current_case, true);
  assert.equal(runtimeContext.case_context.current_case.case_type, "booking");
  assert.equal(runtimeContext.case_context.current_case.topic, "crown");
  assert.equal(runtimeContext.case_context.current_case.case_id, undefined);
  assert.equal(runtimeContext.case_context.recent_cases[0].case_id, undefined);
  assert.equal(runtimeContext.booking_context.has_active_hold, true);
  assert.equal(runtimeContext.booking_context.latest_appointment.start_at, "2026-06-01T09:00:00Z");
  assert.equal(runtimeContext.current_case_id, undefined);

  const debug = (response.payload as any).debug.case_context;
  assert.equal(debug.loaded, true);
  assert.equal(debug.open_cases_count, 2);
  assert.equal(debug.recent_cases_count, 1);
  assert.equal(debug.has_current_case, true);
  assert.equal(debug.current_case_resolved, true);
});

test("case context load failure is non-fatal", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    undefined,
    { async loadCaseContext() { return { ok: false, error: { code: "case_context_load_failed", message: "rpc failed", retryable: true } }; } },
  );
  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "hello" });
  assert.equal(response.statusCode, 200);
  const debug = (response.payload as any).debug.case_context;
  assert.equal(debug.loaded, false);
  assert.equal(debug.error.code, "case_context_load_failed");
});

test("classifier valid output is attached to debug envelope", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    undefined,
    undefined,
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "Need to reschedule" });
  const payload = response.payload as Record<string, any>;
  assert.equal(payload.debug.runtime_gate.mode, "shadow");
  assert.equal(payload.debug.runtime_gate.route, "non_operational");
  assert.equal(payload.debug.runtime_gate.should_apply, false);
  assert.equal(payload.debug.legacy_case_router.mode, "shadow");
  assert.equal(payload.debug.legacy_case_router.decision.should_apply, false);
});

test("classifier output fallback remains non-fatal", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "ok", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "hello" });
  assert.equal(response.statusCode, 200);
});

test("debug.turn_understanding appears in response and log payload for operational candidates", async () => {
  let loggedDebug: Record<string, any> | null = null;
  const calls: Array<Record<string, any>> = [];
  const harness = createRouteHarness(
    { async runTurn(input) { calls.push(input as any); return { final_patient_reply: "unchanged", tool_results: [], debug: { existing: true } } as any; } },
    { async logTurn(input) { loggedDebug = input.debug as Record<string, any>; }, async logError() {} },
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    undefined,
    undefined,
    { async classifyRuntimeGateTurn() { return { route: "operational_candidate", turn_shape: "booking", confidence: "high", reason: "booking", should_apply: false }; } },
    { async classifyTurnUnderstanding() { return { turn_type: "booking_request", topic: "appointment booking", service_interest: null, subject: { kind: "self", display_name: null }, reply_objective: "ask_missing_field", case_decision: { action: "open_new", case_kind: "booking", target_case_id: null }, slot_updates: { service_interest: null, preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null }, missing_fields: ["phone", "service_interest"], confidence: "high", reason: "User asks to book", should_apply: false }; } },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "могу записаться?" });
  const payload = response.payload as Record<string, any>;

  assert.equal(payload.final_patient_reply, "unchanged");
  assert.equal(payload.debug.turn_understanding.enabled, true);
  assert.equal(payload.debug.turn_understanding.mode, "shadow");
  assert.equal(payload.debug.turn_understanding.skipped, false);
  assert.equal(payload.debug.turn_understanding.decision.turn_type, "booking_request");
  assert.equal(payload.debug.turn_understanding.decision.should_apply, false);
  assert.deepEqual(payload.debug.turn_understanding.decision.missing_fields, ["service_interest"]);
  assert.equal(payload.debug.topic_memory_candidate.enabled, true);
  assert.equal(payload.debug.topic_memory_candidate.mode, "shadow");
  assert.equal(payload.debug.topic_memory_candidate.should_update, false);
  assert.equal(payload.debug.topic_memory_candidate.topic_kind, null);
  assert.equal(payload.debug.reply_context_builder.enabled, true);
  assert.equal(payload.debug.reply_context_builder.mode, "shadow");
  assert.equal(payload.debug.reply_context_builder.skipped, false);
  assert.equal(payload.debug.reply_context_builder.context.what_to_do, "ask_missing_fields");
  assert.ok(payload.debug.reply_context_builder.context.do_not_ask.includes("phone"));
  assert.equal(payload.debug.legacy_case_router.mode, "shadow");
  assert.equal(loggedDebug?.turn_understanding.decision.turn_type, "booking_request");
  assert.equal(loggedDebug?.topic_memory_candidate.should_update, false);
  assert.equal(loggedDebug?.reply_context_builder.context.what_to_do, "ask_missing_fields");
  assert.deepEqual(calls[0].business_context.meta, undefined);
  assert.equal(calls[0].business_context.topic_memory_candidate, undefined);
  assert.equal(calls[0].business_context.reply_context_builder, undefined);
});

test("debug.topic_memory_candidate appears after turn understanding and before reply context", async () => {
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "same reply", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    undefined,
    undefined,
    { async classifyRuntimeGateTurn() { return { route: "operational_candidate", turn_shape: "slot_fragment", confidence: "high", reason: "service", should_apply: false }; } },
    { async classifyTurnUnderstanding() { return { turn_type: "slot_fill", topic: null, service_interest: "пломба", subject: { kind: "self", display_name: null }, reply_objective: "ask_missing_field", case_decision: { action: "open_new", case_kind: "booking", target_case_id: null }, slot_updates: { service_interest: "пломба", preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null }, missing_fields: [], confidence: "high", reason: "service named", should_apply: false }; } },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "на пломбу" });
  const payload = response.payload as Record<string, any>;
  const debugKeys = Object.keys(payload.debug);

  assert.equal(payload.final_patient_reply, "same reply");
  assert.equal(payload.debug.topic_memory_candidate.enabled, true);
  assert.equal(payload.debug.topic_memory_candidate.mode, "shadow");
  assert.equal(payload.debug.topic_memory_candidate.should_update, true);
  assert.equal(payload.debug.topic_memory_candidate.topic_kind, "service_interest");
  assert.equal(payload.debug.topic_memory_candidate.topic_value, "пломба");
  assert.equal(payload.debug.topic_memory_candidate.confidence, "high");
  assert.equal(payload.debug.topic_memory_candidate.reason, null);
  assert.ok(debugKeys.indexOf("runtime_gate") < debugKeys.indexOf("turn_understanding"));
  assert.ok(debugKeys.indexOf("turn_understanding") < debugKeys.indexOf("topic_memory_candidate"));
  assert.ok(debugKeys.indexOf("topic_memory_candidate") < debugKeys.indexOf("reply_context_builder"));
});

test("debug.turn_understanding skips for non operational runtime gate", async () => {
  let classifierCalls = 0;
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "faq reply", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    undefined,
    undefined,
    { async classifyRuntimeGateTurn() { return { route: "non_operational", turn_shape: "faq", confidence: "high", reason: "faq", should_apply: false }; } },
    { async classifyTurnUnderstanding() { classifierCalls += 1; throw new Error("should skip"); } },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "Сколько стоит чистка?" });
  const payload = response.payload as Record<string, any>;

  assert.equal(payload.final_patient_reply, "faq reply");
  assert.equal(payload.debug.turn_understanding.skipped, true);
  assert.equal(payload.debug.turn_understanding.skip_reason, "runtime_gate_non_operational");
  assert.equal(payload.debug.turn_understanding.decision, null);
  assert.equal(payload.debug.topic_memory_candidate.should_update, false);
  assert.equal(payload.debug.topic_memory_candidate.reason, "turn_understanding_skipped");
  assert.equal(payload.debug.reply_context_builder.skipped, true);
  assert.equal(payload.debug.reply_context_builder.skip_reason, "turn_understanding_skipped");
  assert.equal(payload.debug.reply_context_builder.context, null);
  assert.equal(classifierCalls, 0);
});

test("turn understanding invalid route classifier output safely falls back without DB writes or reply changes", async () => {
  const persistenceCalls: string[] = [];
  const harness = createRouteHarness(
    { runTurn: async () => ({ final_patient_reply: "same", tool_results: [] }) as any },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    {
      async getOrCreateContact(input) { persistenceCalls.push("contact"); return { ok: true, data: { contact_id: `${input.channel}:persisted`, clinic_id: CLINIC_UUID } }; },
      async registerInboundEvent() { persistenceCalls.push("inbound"); return { ok: true, data: {} }; },
      async saveMessage(input) { persistenceCalls.push(`message:${input.role}`); return { ok: true, data: { message_id: `m_${input.role}` } }; },
      async mergeConversationState() { persistenceCalls.push("merge"); return { ok: true, data: {} }; },
    },
    defaultClinicIdentityResolver,
    undefined,
    undefined,
    { async classifyRuntimeGateTurn() { return { route: "operational_candidate", turn_shape: "slot_fragment", confidence: "high", reason: "slot", should_apply: false }; } },
    { async classifyTurnUnderstanding() { return { nope: true }; } },
  );

  const response = await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", chat_id: "chat_1", text: "14.00 михаил огар" });
  const payload = response.payload as Record<string, any>;

  assert.equal(payload.final_patient_reply, "same");
  assert.equal(payload.debug.turn_understanding.skipped, false);
  assert.equal(payload.debug.turn_understanding.decision.turn_type, "unknown");
  assert.equal(payload.debug.turn_understanding.decision.reply_objective, "safe_fallback");
  assert.equal(payload.debug.turn_understanding.decision.case_decision.action, "none");
  assert.equal(payload.debug.turn_understanding.decision.should_apply, false);
  assert.equal(payload.debug.turn_understanding.error, "classifier_invalid_output");
  assert.equal(payload.debug.topic_memory_candidate.should_update, false);
  assert.equal(payload.debug.reply_context_builder.context.what_to_do, "safe_fallback");
  assert.deepEqual(persistenceCalls, ["contact", "inbound", "message:user", "message:assistant", "merge"]);
});

test("turn understanding sanitizer does not change main agent runtime_context", async () => {
  const calls: Array<Record<string, any>> = [];
  const turnUnderstandingInputs: Array<Record<string, any>> = [];
  const harness = createRouteHarness(
    { async runTurn(input) { calls.push(input as any); return { final_patient_reply: "ok", tool_results: [] } as any; } },
    createNoopRuntimeTurnLogger(),
    undefined,
    undefined,
    undefined,
    defaultClinicIdentityResolver,
    { async loadRuntimeContext() { return { ok: true, data: { known_contact: {}, conversation_state: { intent: "booking", collected: {}, missing_fields: [], last_bot_question: "Когда удобно?", pending_slots: ["preferred_date"] }, runtime_flags: { has_durable_context: true, context_source: "supabase", context_loaded_at: "2026-01-01T00:00:00.000Z" }, recent_history: [{ role: "assistant", text: "raw" }] } }; } },
    undefined,
    { async classifyRuntimeGateTurn() { return { route: "operational_candidate", turn_shape: "slot_fragment", confidence: "high", reason: "slot", should_apply: false }; } },
    { async classifyTurnUnderstanding(input) { turnUnderstandingInputs.push(input.runtime_context as any); return { turn_type: "slot_fill", topic: null, service_interest: "чистка", subject: { kind: "self", display_name: null }, reply_objective: "ask_missing_field", case_decision: { action: "continue_existing", case_kind: "booking", target_case_id: null }, slot_updates: { service_interest: "чистка", preferred_date: "05.06", preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null }, missing_fields: [], confidence: "medium", reason: "slot details", should_apply: false }; } },
  );

  await harness.invoke({ clinic_code: CLINIC_UUID, channel: "telegram", external_user_id: "user_1", text: "чистка зубов на 05.06" });

  const mainContext = calls[0].business_context.runtime_context;
  assert.equal(mainContext.task_state.last_bot_question, undefined);
  assert.equal(mainContext.task_state.pending_slots, undefined);
  assert.deepEqual(mainContext.recent_history, []);
  assert.equal(calls[0].business_context.topic_memory_candidate, undefined);
  assert.equal(turnUnderstandingInputs[0].last_bot_question, "Когда удобно?");
  assert.deepEqual(turnUnderstandingInputs[0].pending_slots, ["preferred_date"]);
});

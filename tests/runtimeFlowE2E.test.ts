import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDentalRuntimeTurnService } from "../src/runtime/runtimeTurnService.ts";
import type { OpenAIResponsesClient } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";

function makeBaseInput(userMessage: string) {
  return {
    trace_id: "trace_e2e_1",
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: userMessage,
    locale: "ru",
    business_context: { channel: "web" },
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
    recent_summary: "",
  };
}

function createMockClient(responses: unknown[]) {
  const calls: unknown[] = [];
  const client: OpenAIResponsesClient = {
    responses: {
      create: async (input: unknown) => {
        calls.push(input);
        const next = responses.shift();
        return next ?? { output_text: "Безопасный ответ по умолчанию." };
      },
    },
  };
  return { client, calls };
}

test("FAQ flow via RuntimeTurnService executes kb.search and returns AI final reply", async () => {
  const { client, calls } = createMockClient([
    {
      conversation_id: "conv_faq_1",
      tool_calls: [{ name: "kb.search", arguments: { query: "Сколько стоит чистка?" }, call_id: "call_kb_1" }],
    },
    {
      conversation_id: "conv_faq_1",
      final_response: { final_patient_reply: "Профессиональная чистка стоит от 5 000 ₽." },
    },
  ]);
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const service = createDentalRuntimeTurnService({
    model: "gpt-test",
    openaiClient: client,
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      if (fn === "core.rpc_kb_search_v1") {
        return { data: [{ chunk_id: "kb_1", text: "Чистка от 5 000 ₽" }], error: null };
      }
      return { data: null, error: { code: "unexpected_fn", message: fn, retryable: false } };
    },
  });

  const result = await service.runTurn(makeBaseInput("Сколько стоит чистка?"));

  assert.equal(result.final_patient_reply, "Профессиональная чистка стоит от 5 000 ₽.");
  assert.equal(result.tool_results[0]?.status, "success");
  assert.equal(rpcCalls[0]?.fn, "core.rpc_kb_search_v1");
  assert.equal(JSON.parse((calls[1] as any).input[0].content[0].text).tool_results[0].status, "success");
  assert.equal(JSON.parse((calls[1] as any).input[0].content[0].text).tool_results[0].tool, "kb.search");
});

test("Availability flow via RuntimeTurnService executes availability.check and returns AI final reply", async () => {
  const { client, calls } = createMockClient([
    {
      conversation_id: "conv_av_1",
      tool_calls: [{
        name: "availability.check",
        arguments: { requested_date: "2026-05-23", requested_time: "evening" },
        call_id: "call_av_1",
      }],
    },
    { final_response: { final_patient_reply: "На завтра вечером есть окна в 18:00 и 19:00." } },
  ]);
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const service = createDentalRuntimeTurnService({
    model: "gpt-test",
    openaiClient: client,
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      if (fn === "core.rpc_check_availability_v1") {
        return {
          data: [{ slot_key: "slot_1", starts_at: "2026-05-23T18:00:00+03:00", ends_at: "2026-05-23T18:30:00+03:00" }],
          error: null,
        };
      }
      return { data: null, error: { code: "unexpected_fn", message: fn, retryable: false } };
    },
  });

  const result = await service.runTurn(makeBaseInput("Есть завтра вечером?"));

  assert.equal(result.tool_results[0]?.status, "success");
  assert.equal(rpcCalls[0]?.fn, "core.rpc_check_availability_v1");
  assert.equal(JSON.parse((calls[1] as any).input[0].content[0].text).tool_results[0].tool, "availability.check");
  assert.equal(result.final_patient_reply, "На завтра вечером есть окна в 18:00 и 19:00.");
});

test("memory continuity persists and reuses conversation_id across turns", async () => {
  const memoryLoads: unknown[] = [];
  const memorySaves: unknown[] = [];
  const memoryRepo: ConversationMemoryRepository = {
    getConversationMemory: async (input) => {
      memoryLoads.push(input);
      return { ok: true, data: { conversation_id: "conv_case_1" } };
    },
    saveConversationMemory: async (input) => {
      memorySaves.push(input);
      return { ok: true, data: { conversation_id: input.conversation_id } };
    },
  };

  const { client, calls } = createMockClient([
    { final_response: { final_patient_reply: "Могу помочь с записью." }, conversation_id: "conv_case_1" },
    { final_response: { final_patient_reply: "Да, вечером есть варианты." }, conversation_id: "conv_case_1" },
  ]);

  const service = createDentalRuntimeTurnService({
    model: "gpt-test",
    openaiClient: client,
    rpc: async () => ({ data: null, error: null }),
    conversationMemoryRepository: memoryRepo,
  });

  await service.runTurn(makeBaseInput("Хочу на чистку"));
  const second = await service.runTurn(makeBaseInput("а завтра вечером?"));

  assert.equal((memorySaves[0] as any).conversation_id, "conv_case_1");
  assert.equal((calls[1] as any).conversation, "conv_case_1");
  assert.equal(memoryLoads.length >= 1, true);
  assert.equal(second.final_patient_reply, "Да, вечером есть варианты.");
});

test("inactive future tool booking.confirm is denied and returned as tool_result", async () => {
  const { createRuntimeAgentLoop } = await import("../src/runtime/runtimeAgentLoop.ts");
  const { createRuntimeTurnService } = await import("../src/runtime/runtimeTurnService.ts");

  const callerInputs: unknown[] = [];
  const caller = async (input: any) => {
    callerInputs.push(input);
    if (!input.input.tool_results) {
      return { type: "tool_requests", tool_requests: [{ tool: "booking.confirm", arguments: {}, call_id: "call_booking_1" }] };
    }
    return { type: "final_response", final_response: { final_patient_reply: "Я не могу подтвердить запись в этом канале, но помогу дальше." } };
  };

  const agent = createRuntimeAgentLoop({
    model: "gpt-test",
    caller,
    executors: {
      "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }),
      "availability.check": async () => ({ tool: "availability.check", status: "success", data: { slots: [] } }),
    },
  });
  const service = createRuntimeTurnService({ agent });

  const result = await service.runTurn(makeBaseInput("Подтвердите запись"));

    assert.equal(result.tool_results[0]?.status, "denied");
  assert.equal(result.tool_results[0]?.error?.code, "tool_not_active");
  assert.equal((callerInputs[1] as any).input.tool_results[0].status, "denied");
  assert.equal(result.final_patient_reply.length > 0, true);
});

test("malformed OpenAI output returns safe fallback without rpc execution", async () => {
  const { client } = createMockClient(["malformed"]);
  const rpcCalls: string[] = [];
  const service = createDentalRuntimeTurnService({
    model: "gpt-test",
    openaiClient: client,
    rpc: async (fn) => {
      rpcCalls.push(fn);
      return { data: null, error: null };
    },
  });

  const result = await service.runTurn(makeBaseInput("Что по цене?"));

  assert.match(result.final_patient_reply, /trouble processing/i);
  assert.equal(rpcCalls.length, 0);
  assert.deepEqual(result.tool_results, []);
});

test("rpc failure is surfaced as failed tool_result and second OpenAI call still returns final reply", async () => {
  const { client, calls } = createMockClient([
    { tool_calls: [{ name: "kb.search", arguments: { query: "Сколько стоит чистка?" }, call_id: "call_kb_fail" }] },
    { output_text: "Не удалось получить базу знаний, но я могу уточнить детали." },
  ]);

  const service = createDentalRuntimeTurnService({
    model: "gpt-test",
    openaiClient: client,
    rpc: async (fn) => {
      if (fn === "core.rpc_kb_search_v1") {
        return { data: null, error: { code: "rpc_down", message: "KB unavailable", retryable: true } };
      }
      return { data: null, error: null };
    },
  });

  const result = await service.runTurn(makeBaseInput("Сколько стоит чистка?"));

  assert.equal(result.tool_results[0]?.status, "failed");
  assert.equal(JSON.parse((calls[1] as any).input[0].content[0].text).tool_results[0].status, "failed");
  assert.equal(result.final_patient_reply, "Не удалось получить базу знаний, но я могу уточнить детали.");
});

test("runtime flow modules remain free of n8n/telegram integrations", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const files = [
    resolve(thisDir, "../src/runtime/runtimeTurnService.ts"),
    resolve(thisDir, "../src/runtime/dentalRuntimeAgentFactory.ts"),
    resolve(thisDir, "../src/runtime/runtimeAgentLoop.ts"),
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
    assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { OpenAIPlanner } from "../src/runtime/openaiPlanner.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";
import { runRuntimeTurnAssembly } from "../src/runtime/runtimeTurnAssembly.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

// existing tests

test("kb.search path executes allowed tool and returns chunks", async () => {
  const planner: OpenAIPlanner = { plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: ["kb.search"] }, conversation_id: "conv_1" }) };
  const executors: ToolExecutorRegistry = { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "k1", text: "hours info" }] } }) };
  const result = await runRuntimeTurnAssembly({ clinic_id: "clinic_1", user_message: "What are your hours?", execution_context: { query_text: "hours" } }, { planner, executors });
  assert.equal(result.tool_results[0]?.tool, "kb.search");
});

test("load before planner uses repository conversation id", async () => {
  let plannerConversationId: string | null | undefined;
  const planner: OpenAIPlanner = {
    plan: async (input) => {
      plannerConversationId = input.conversation_id;
      return { raw_planner_output: { confidence: "high", tools_requested: [] }, conversation_id: "conv_123" };
    },
  };
  const memoryRepo: ConversationMemoryRepository = {
    getConversationMemory: async () => ({ ok: true, data: { conversation_id: "conv_123" } }),
    saveConversationMemory: async () => ({ ok: true, data: { conversation_id: "conv_123" } }),
  };

  await runRuntimeTurnAssembly({ clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "hello" }, { planner, executors: {}, conversationMemoryRepository: memoryRepo });
  assert.equal(plannerConversationId, "conv_123");
});

test("explicit input conversation_id wins over repository", async () => {
  let plannerConversationId: string | null | undefined;
  const planner: OpenAIPlanner = { plan: async (input) => { plannerConversationId = input.conversation_id; return { raw_planner_output: { confidence: "high", tools_requested: [] } }; } };
  const memoryRepo: ConversationMemoryRepository = {
    getConversationMemory: async () => ({ ok: true, data: { conversation_id: "conv_repo" } }),
    saveConversationMemory: async () => ({ ok: true, data: { conversation_id: "conv_repo" } }),
  };

  await runRuntimeTurnAssembly({ clinic_id: "clinic_1", conversation_id: "conv_input", user_message: "hello" }, { planner, executors: {}, conversationMemoryRepository: memoryRepo });
  assert.equal(plannerConversationId, "conv_input");
});

test("planner returned conversation memory is saved", async () => {
  let savedConversationId: string | undefined;
  const planner: OpenAIPlanner = { plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: [] }, conversation_id: "conv_new" }) };
  const memoryRepo: ConversationMemoryRepository = {
    getConversationMemory: async () => ({ ok: true, data: { conversation_id: null } }),
    saveConversationMemory: async (input) => { savedConversationId = input.conversation_id; return { ok: true, data: { conversation_id: input.conversation_id } }; },
  };

  await runRuntimeTurnAssembly({ clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1", user_message: "hello" }, { planner, executors: {}, conversationMemoryRepository: memoryRepo });
  assert.equal(savedConversationId, "conv_new");
});

test("repository load failure is non-fatal and planner receives null", async () => {
  let plannerConversationId: string | null | undefined;
  const planner: OpenAIPlanner = { plan: async (input) => { plannerConversationId = input.conversation_id; return { raw_planner_output: { confidence: "high", tools_requested: [] } }; } };
  const memoryRepo: ConversationMemoryRepository = {
    getConversationMemory: async () => { throw new Error("load failed"); },
    saveConversationMemory: async () => ({ ok: true, data: { conversation_id: "x" } }),
  };

  const result = await runRuntimeTurnAssembly({ clinic_id: "clinic_1", user_message: "hello" }, { planner, executors: {}, conversationMemoryRepository: memoryRepo });
  assert.equal(plannerConversationId, null);
  assert.equal(result.debug_envelope.memory_load_error, "load failed");
});

test("repository save failure is non-fatal and tools remain valid", async () => {
  const planner: OpenAIPlanner = { plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: ["kb.search"] }, conversation_id: "conv_new" }) };
  const memoryRepo: ConversationMemoryRepository = {
    getConversationMemory: async () => ({ ok: true, data: { conversation_id: null } }),
    saveConversationMemory: async () => { throw new Error("save failed"); },
  };
  const executors: ToolExecutorRegistry = { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }) };

  const result = await runRuntimeTurnAssembly({ clinic_id: "clinic_1", user_message: "hello" }, { planner, executors, conversationMemoryRepository: memoryRepo });
  assert.equal(result.tool_results[0]?.status, "success");
  assert.equal(result.debug_envelope.memory_save_error, "save failed");
});

test("case-scoped memory passes case_id", async () => {
  let capturedCaseId: string | null | undefined;
  const planner: OpenAIPlanner = { plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: [] } }) };
  const memoryRepo: ConversationMemoryRepository = {
    getConversationMemory: async (input) => { capturedCaseId = input.case_id; return { ok: true, data: { conversation_id: null } }; },
    saveConversationMemory: async () => ({ ok: true, data: { conversation_id: "conv" } }),
  };

  await runRuntimeTurnAssembly({ clinic_id: "clinic_1", case_id: "case_123", user_message: "hello" }, { planner, executors: {}, conversationMemoryRepository: memoryRepo });
  assert.equal(capturedCaseId, "case_123");
});

test("no repository still works and planner receives null conversation_id", async () => {
  let plannerConversationId: string | null | undefined;
  const planner: OpenAIPlanner = { plan: async (input) => { plannerConversationId = input.conversation_id; return { raw_planner_output: { confidence: "high", tools_requested: [] } }; } };

  const result = await runRuntimeTurnAssembly({ clinic_id: "clinic_1", user_message: "hello" }, { planner, executors: {} });
  assert.equal(plannerConversationId, null);
  assert.equal(result.conversation_id, null);
});

test("conversation memory continuity is not business truth", async () => {
  const source = await readFile(new URL("../src/runtime/runtimeRepositories.ts", import.meta.url), "utf8");
  assert.match(source, /never source of truth for business[\s\S]*state/);
});

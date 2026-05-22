import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { OpenAIPlanner } from "../src/runtime/openaiPlanner.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";
import { runRuntimeTurnAssembly } from "../src/runtime/runtimeTurnAssembly.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";

test("kb.search path executes allowed tool and returns chunks", async () => {
  const planner: OpenAIPlanner = {
    plan: async () => ({
      raw_planner_output: { confidence: "high", tools_requested: ["kb.search"] },
      conversation_id: "conv_1",
    }),
  };

  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({
      tool: "kb.search",
      status: "success",
      data: { chunks: [{ chunk_id: "k1", text: "hours info" }] },
    }),
  };

  const result = await runRuntimeTurnAssembly({
    clinic_id: "clinic_1",
    user_message: "What are your hours?",
    execution_context: { query_text: "hours" },
  }, { planner, executors });

  assert.equal(result.tool_results[0]?.tool, "kb.search");
  assert.equal(result.tool_results[0]?.status, "success");
});

test("availability.check path executes with scheduling truth", async () => {
  const planner: OpenAIPlanner = {
    plan: async () => ({
      raw_planner_output: {
        turn_type: "availability_request",
        confidence: "high",
        tools_requested: ["availability.check"],
      },
      conversation_id: "conv_2",
    }),
  };

  let called = false;
  const executors: ToolExecutorRegistry = {
    "availability.check": async () => {
      called = true;
      return { tool: "availability.check", status: "success", data: { slots: [{ starts_at: "2026-06-01T09:00:00Z" }] } };
    },
  };

  const result = await runRuntimeTurnAssembly({
    clinic_id: "clinic_1",
    user_message: "Need next monday morning",
    truth_input: { current_turn_flags: { scheduling_intent_present: true, date_or_time_present: true } },
    execution_context: { requested_date: "next monday", requested_time: "morning" },
  }, { planner, executors });

  assert.equal(called, true);
  assert.equal(result.tool_results[0]?.tool, "availability.check");
});

test("denied and invalid tools do not execute", async () => {
  let called = false;
  const executors: ToolExecutorRegistry = {
    "booking.confirm": async () => {
      called = true;
      return { tool: "booking.confirm", status: "success", data: { appointment_id: "a1" } as never };
    },
  };

  const plannerDenied: OpenAIPlanner = {
    plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: ["booking.confirm"] } }),
  };
  const deniedResult = await runRuntimeTurnAssembly({ clinic_id: "c1", user_message: "book it" }, { planner: plannerDenied, executors });
  assert.equal(deniedResult.execution_plan.tools_allowed.includes("booking.confirm"), false);

  const plannerInvalid: OpenAIPlanner = {
    plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: ["admin.notify"] } }),
  };
  const invalidResult = await runRuntimeTurnAssembly({ clinic_id: "c1", user_message: "notify admin" }, { planner: plannerInvalid, executors });
  assert.equal(invalidResult.execution_plan.tools_allowed.length, 0);
  assert.equal(called, false);
});

test("parse failure yields safe fallback with no tool execution", async () => {
  let called = false;
  const planner: OpenAIPlanner = { plan: async () => ({ raw_planner_output: ["bad"] }) };
  const executors: ToolExecutorRegistry = { "kb.search": async () => { called = true; return { tool: "kb.search", status: "success", data: { chunks: [] } }; } };

  const result = await runRuntimeTurnAssembly({ clinic_id: "c1", user_message: "x" }, { planner, executors });

  assert.equal(result.parsed_planner.ok, false);
  assert.equal(result.execution_plan.tools_allowed.length, 0);
  assert.equal(called, false);
});

test("trusted context cannot be overridden by execution_context", async () => {
  let captured: any;
  const planner: OpenAIPlanner = { plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: ["kb.search"] } }) };
  const executors: ToolExecutorRegistry = {
    "kb.search": async (ctx) => {
      captured = ctx;
      return { tool: "kb.search", status: "success", data: { chunks: [] } };
    },
  };

  const result = await runRuntimeTurnAssembly({
    trace_id: "t1",
    clinic_id: "clinic_top",
    contact_id: "contact_top",
    case_id: "case_top",
    user_message: "help",
    execution_context: {
      clinic_id: "clinic_spoof",
      contact_id: "contact_spoof",
      case_id: "case_spoof",
      planner: { confidence: "high", tools_requested: ["booking.confirm"] } as never,
      truth_snapshot: { active_hold_exists: true } as never,
    },
  }, { planner, executors });

  assert.equal(captured.clinic_id, "clinic_top");
  assert.equal(captured.contact_id, "contact_top");
  assert.equal(captured.case_id, "case_top");
  assert.deepEqual(captured.planner, result.parsed_planner.planner);
  assert.deepEqual(captured.truth_snapshot, result.truth_snapshot);
});

test("side effects and conversation_id pass-through", async () => {
  const planner: OpenAIPlanner = {
    plan: async () => ({ raw_planner_output: { confidence: "high", tools_requested: [] }, conversation_id: "conv_42" }),
  };

  const result = await runRuntimeTurnAssembly({ clinic_id: "c1", user_message: "x", backend_events: ["booking.confirm.success"] }, { planner, executors: {} });

  assert.equal(result.policy_result.side_effects.length, 0);
  assert.equal(result.side_effects.some((effect) => effect.type === "admin.notify"), true);
  assert.equal(result.conversation_id, "conv_42");
});

test("planner throw returns safe failure and no tool execution", async () => {
  let called = false;
  const planner: OpenAIPlanner = { plan: async () => { throw new Error("planner down"); } };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => { called = true; return { tool: "kb.search", status: "success", data: { chunks: [] } }; },
  };

  const result = await runRuntimeTurnAssembly({ clinic_id: "c1", user_message: "x" }, { planner, executors });

  assert.equal(called, false);
  assert.equal(result.tool_results.length, 0);
  assert.equal(result.debug_envelope.runtime_error?.code, "planner_execution_failed");
});

test("assembly has no forbidden integrations", async () => {
  const source = await readFile(new URL("../src/runtime/runtimeTurnAssembly.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /supabase|postgres|rpc|telegram|n8n|from\s+["']openai["']/i);
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

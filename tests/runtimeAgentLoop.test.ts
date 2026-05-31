import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeAgentLoop, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
import type { ToolExecutorRegistry } from "../src/runtime/toolExecutor.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";

function makeInput() {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "Can you check tomorrow?",
    locale: "en",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  };
}

test("final response without tools returns immediate reply", async () => {
  let calls = 0;
  const caller: RuntimeAgentCaller = async () => {
    calls += 1;
    return { type: "final_response", final_response: { final_patient_reply: "Hello" }, conversation_id: "conv_1" };
  };

  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput());

  assert.equal(calls, 1);
  assert.equal(result.final_patient_reply, "Hello");
  assert.deepEqual(result.tool_requests, []);
  assert.deepEqual(result.tool_results, []);
});


test("debug.llm_calls marks main agent when caller is invoked", async () => {
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    final_response: { final_patient_reply: "Hello" },
    conversation_id: "conv_1",
  });

  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput());

  assert.deepEqual((result.debug as any).llm_calls, {
    runtime_gate_called: false,
    turn_understanding_called: false,
    legacy_case_router_called: false,
    main_agent_called: true,
    total_llm_calls: 1,
  });
});

test("kb.search tool path executes and returns second-call final reply", async () => {
  const seen: unknown[] = [];
  const caller: RuntimeAgentCaller = async (input) => {
    seen.push(input);
    if (seen.length === 1) {
      return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "insurance" }, call_id: "c1" }] };
    }
    return { type: "final_response", final_response: { final_patient_reply: "We accept PPO." } };
  };

  const executors: ToolExecutorRegistry = {
    "kb.search": async (ctx) => ({ tool: "kb.search", status: "success", data: { query: ctx.query_text, chunks: [] } }),
  };

  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors });
  const result = await agent.runTurn(makeInput());

  assert.equal(result.final_patient_reply, "We accept PPO.");
  assert.equal(result.tool_results[0].status, "success");
  assert.equal((seen[1] as any).input.tool_results.length, 1);
});

test("availability.check path executes", async () => {
  let executed = false;
  const callerInputs: Array<Parameters<RuntimeAgentCaller>[0]> = [];
  const caller: RuntimeAgentCaller = async (input) => {
    callerInputs.push(input);
    if (!input.input.tool_results) {
      return {
        type: "tool_requests",
        tool_requests: [{ tool: "availability.check", arguments: { requested_date: "2026-05-23", requested_time: "10:00" } }],
      };
    }
    return { type: "final_response", final_response: { final_patient_reply: "We have 10:00 AM." } };
  };
  const executors: ToolExecutorRegistry = {
    "availability.check": async () => {
      executed = true;
      return { tool: "availability.check", status: "success", data: { slots: [{ slot_id: "s1", starts_at: "a", ends_at: "b" }] } };
    },
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors }).runTurn(makeInput());
  assert.equal(result.final_patient_reply, "We have 10:00 AM.");
  assert.equal(executed, true);
  assert.equal(Array.isArray(callerInputs[1]?.input.tool_results), true);
  assert.equal(callerInputs[1]?.input.tool_results?.[0]?.status, "success");
  assert.equal(result.tool_results[0]?.status, "success");
});

test("inactive and unknown tools are denied", async () => {
  const requested = [{ tool: "booking.confirm", arguments: {} }, { tool: "admin.notify" as any, arguments: {} }];
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results) return { type: "tool_requests", tool_requests: requested as any };
    return { type: "final_response", final_response: { final_patient_reply: "done" } };
  };
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors: {} }).runTurn(makeInput());
  assert.equal(result.tool_results.length, 2);
  assert.equal(result.tool_results[0].status, "denied");
  assert.equal(result.tool_results[0].error?.code, "tool_not_active");
  assert.equal(result.tool_results[1].status, "denied");
});

test("policy denial blocks availability execution when truth flags are missing", async () => {
  let executed = false;
  const caller: RuntimeAgentCaller = async (input) => {
    if (!input.input.tool_results) {
      return { type: "tool_requests", tool_requests: [{ tool: "availability.check", arguments: {} }] };
    }
    return { type: "final_response", final_response: { final_patient_reply: "fallback" } };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "availability.check": async () => { executed = true; throw new Error("should not run"); } },
  }).runTurn({ ...makeInput(), truth_snapshot: {} });
  assert.equal(executed, false);
  assert.equal(result.tool_results[0].status, "denied");
});

test("memory load and save are used and non-fatal on failures", async () => {
  const repo: ConversationMemoryRepository = {
    getConversationMemory: async () => ({ ok: true, data: { conversation_id: "conv_mem" } }),
    saveConversationMemory: async () => ({ ok: false, error: { code: "x", message: "nope", retryable: false } }),
  };
  const caller: RuntimeAgentCaller = async () => ({ type: "final_response", conversation_id: "conv_new", final_response: { final_patient_reply: "ok" } });
  const result = await createRuntimeAgentLoop({ model: "m", caller, executors: {}, conversationMemoryRepository: repo }).runTurn(makeInput());
  assert.equal(result.conversation_id, "conv_new");
  assert.equal((result.debug as any).memory_loaded, true);
  assert.equal((result.debug as any).memory_saved, false);
});

test("first and second caller failures return safe replies", async () => {
  const firstFail = createRuntimeAgentLoop({
    model: "m",
    caller: async () => { throw new Error("boom"); },
    executors: {},
  });
  const firstResult = await firstFail.runTurn(makeInput());
  assert.match(firstResult.final_patient_reply, /trouble processing/i);
  assert.equal((firstResult.debug as any).runtime_error.code, "agent_caller_failed");
  assert.equal((firstResult.debug as any).runtime_error.message, "boom");

  let run = 0;
  const secondFail = createRuntimeAgentLoop({
    model: "m",
    caller: async () => {
      run += 1;
      if (run === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "q" } }] };
      throw new Error("boom2");
    },
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }) },
  });
  const secondResult = await secondFail.runTurn(makeInput());
  assert.match(secondResult.final_patient_reply, /having trouble wording/i);
  assert.equal(secondResult.tool_results.length, 1);
  assert.equal((secondResult.debug as any).runtime_error.code, "agent_final_response_failed");
  assert.equal((secondResult.debug as any).runtime_error.message, "boom2");
});

test("multi-round tool loop is not implemented", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "x" } }] };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "y" } }] };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }) },
  }).runTurn(makeInput());
  assert.equal(result.final_patient_reply, "Let me clarify that with the clinic team.");
  assert.equal((result.debug as any).reason, "multi_round_tool_loop_not_implemented");
});

test("runtimeAgentLoop has no forbidden external imports and preserves ownership boundaries", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/runtimeAgentLoop.ts");
  const docsPath = resolve(thisDir, "../docs/OPENAI_RUNTIME_AGENT_LOOP.md");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["']openai["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*supabase[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*calendar[^"']*["']/i);

  const docs = await readFile(docsPath, "utf8");
  assert.match(docs, /AI owns final_patient_reply/i);
  assert.match(docs, /Backend owns tool execution/i);
  assert.match(docs, /business truth.*DB|tool results/i);
});

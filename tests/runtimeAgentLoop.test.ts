import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeAgentLoop, buildMultiRoundFallbackReply, hasUsefulToolResults, type RuntimeAgentCaller } from "../src/runtime/runtimeAgentLoop.ts";
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
  // PR #119: non-booking second-call exception now uses the shared locale-aware
  // fallback (buildMalformedResponseFallback) instead of a bespoke English string.
  assert.match(secondResult.final_patient_reply, /trouble processing/i);
  assert.equal(secondResult.tool_results.length, 1);
  assert.equal((secondResult.debug as any).runtime_error.code, "agent_final_response_failed");
  assert.equal((secondResult.debug as any).runtime_error.message, "boom2");
  assert.equal((secondResult.debug as any).reason, "agent_second_call_exception_generic_fallback");
});

test("bounded tool loop fails closed when the third model step still requests tools", async () => {
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
  }).runTurn({ ...makeInput(), locale: "ru" });
  assert.equal(result.final_patient_reply, "Уточню детали с командой клиники — один момент.");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_budget_exhausted");
});

test("runtimeAgentLoop legacy implementation has no forbidden external imports and preserves ownership boundaries", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts");
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

// CBM v1 safety hotfix — English fallback and system instruction tests

test("CBM/bug2: multi-round fallback reply is Russian, not English", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "price" } }] };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "availability" } }] };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }) },
  }).runTurn(makeInput());

  assert.ok(!result.final_patient_reply.toLowerCase().includes("let me clarify"), "fallback must not contain English 'Let me clarify'");
  assert.ok(!result.final_patient_reply.match(/^[A-Z][a-z]+ me /), "fallback must not start with English phrase");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_budget_exhausted");
});

test("CBM/bug2: runtimeAgentLoop legacy implementation does not contain English 'Let me clarify that with the clinic team'", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.ok(!source.includes("Let me clarify that with the clinic team"), "English fallback string must be removed");
});

// CBM P2 fix — locale-aware multi-round fallback

test("CBM/P2: buildMultiRoundFallbackReply returns Russian for ru locale", () => {
  assert.equal(buildMultiRoundFallbackReply("ru"), "Уточню детали с командой клиники — один момент.");
  assert.equal(buildMultiRoundFallbackReply("ru-RU"), "Уточню детали с командой клиники — один момент.");
  assert.equal(buildMultiRoundFallbackReply("uk"), "Уточню детали с командой клиники — один момент.");
  assert.equal(buildMultiRoundFallbackReply(null), "Уточню детали с командой клиники — один момент.");
  assert.equal(buildMultiRoundFallbackReply(undefined), "Уточню детали с командой клиники — один момент.");
});

test("CBM/P2: buildMultiRoundFallbackReply returns English for en locale", () => {
  assert.equal(buildMultiRoundFallbackReply("en"), "I'll clarify the details with the clinic team — one moment.");
  assert.equal(buildMultiRoundFallbackReply("en-US"), "I'll clarify the details with the clinic team — one moment.");
  assert.equal(buildMultiRoundFallbackReply("en-GB"), "I'll clarify the details with the clinic team — one moment.");
});

test("CBM/P2: buildMultiRoundFallbackReply returns Czech for cs locale", () => {
  assert.equal(buildMultiRoundFallbackReply("cs"), "Ověřím podrobnosti s týmem kliniky — chvilku prosím.");
  assert.equal(buildMultiRoundFallbackReply("cs-CZ"), "Ověřím podrobnosti s týmem kliniky — chvilku prosím.");
});

test("CBM/P2: runtimeAgentLoop multi-round fallback respects locale in runTurn — en returns English", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "price" } }] };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "more" } }] };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }) },
  }).runTurn({ ...makeInput(), locale: "en" });

  assert.equal(result.final_patient_reply, "I'll clarify the details with the clinic team — one moment.");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_budget_exhausted");
});

test("CBM/P2: runtimeAgentLoop legacy runTurn path uses locale-aware helper, not a hard-coded reply string", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");

  assert.ok(
    source.includes("buildMultiRoundFallbackReply"),
    "fallback must go through locale-aware helper",
  );
  assert.ok(
    source.includes("buildMultiRoundFallbackReply(input.locale)"),
    "runTurn must call buildMultiRoundFallbackReply with input.locale",
  );
});

// ---------------------------------------------------------------------------
// PR #97 — forced finalization when useful tool_results exist
// ---------------------------------------------------------------------------

// hasUsefulToolResults unit tests

test("hasUsefulToolResults: returns true for kb.search with non-empty chunks", () => {
  const results = [{ tool: "kb.search", status: "success" as const, data: { chunks: [{ chunk_id: "c1", text: "Air-Flow 2500 Kč" }] } }];
  assert.equal(hasUsefulToolResults(results), true);
});

test("hasUsefulToolResults: returns false for kb.search with empty chunks", () => {
  const results = [{ tool: "kb.search", status: "success" as const, data: { chunks: [] } }];
  assert.equal(hasUsefulToolResults(results), false);
});

test("hasUsefulToolResults: returns true for availability.check with non-empty slots", () => {
  const results = [{ tool: "availability.check", status: "success" as const, data: { slots: [{ slot_id: "s1", starts_at: "10:00", ends_at: "11:00" }] } }];
  assert.equal(hasUsefulToolResults(results), true);
});

test("hasUsefulToolResults: returns false for availability.check with empty slots", () => {
  const results = [{ tool: "availability.check", status: "success" as const, data: { slots: [] } }];
  assert.equal(hasUsefulToolResults(results), false);
});

test("hasUsefulToolResults: returns false when status=denied", () => {
  const results = [{ tool: "kb.search", status: "denied" as const, error: { code: "tool_not_active", message: "denied" } }];
  assert.equal(hasUsefulToolResults(results), false);
});

test("hasUsefulToolResults: returns false for empty results array", () => {
  assert.equal(hasUsefulToolResults([]), false);
});

// M1 mixed FAQ+booking — forced finalization integration tests

test("M1: second kb.search batch executes before bounded final response", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async (inp) => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "чистка цена" } }] };
    if (c === 2) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "запись" } }] };
    // Call 3: forced finalization (tool_definitions should be empty)
    return { type: "final_response", final_response: { final_patient_reply: "Чистка стоит 2500 Kč. Хотите записаться?" } };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "c1", text: "Air-Flow 2500 Kč" }] } }) },
  }).runTurn(makeInput());

  assert.equal(result.final_patient_reply, "Чистка стоит 2500 Kč. Хотите записаться?");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_final_response");
  assert.equal(c, 3, "exactly 3 caller invocations: round1, round2, forced finalization");
});

test("M1: forced finalization reply does not contain generic Russian fallback text", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "чистка" } }] };
    if (c === 2) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "запись" } }] };
    return { type: "final_response", final_response: { final_patient_reply: "Чистка — 2500 Kč. Хотите записаться?" } };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "c1", text: "2500 Kč" }] } }) },
  }).runTurn(makeInput());

  assert.ok(
    !result.final_patient_reply.includes("Уточню детали с командой клиники"),
    "forced finalization must not return generic fallback when useful KB result exists",
  );
});

test("M1: bounded loop executes two tool batches and never creates a fourth model call", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "чистка" } }] };
    if (c === 2) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "запись" } }] };
    return { type: "final_response", final_response: { final_patient_reply: "Ответ из KB." } };
  };
  let toolCallCount = 0;
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => { toolCallCount++; return { tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "c1", text: "info" }] } }; } },
  }).runTurn(makeInput());

  assert.equal(c, 3, "max 3 LLM calls");
  assert.equal(toolCallCount, 2, "both model-requested tool batches must execute before the bounded final step");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_final_response");
});

// Locale tests: forced finalization uses caller reply, fallback uses locale when chunks are empty

test("en locale + empty chunks: fallback is English, not Russian", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "price" } }] };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "booking" } }] };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }) },
  }).runTurn({ ...makeInput(), locale: "en" });

  assert.equal(result.final_patient_reply, "I'll clarify the details with the clinic team — one moment.");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_budget_exhausted");
});

test("cs locale + empty chunks: fallback is Czech, not Russian", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "cena" } }] };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "objednat" } }] };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [] } }) },
  }).runTurn({ ...makeInput(), locale: "cs" });

  assert.equal(result.final_patient_reply, "Ověřím podrobnosti s týmem kliniky — chvilku prosím.");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_budget_exhausted");
});

test("failed tool result + multi-round: locale-aware fallback, no forced finalization", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "q" } }] };
    return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "q2" } }] };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "error" as any, error: { code: "kb_failed", message: "KB unavailable" } }) },
  }).runTurn({ ...makeInput(), locale: "ru" });

  assert.equal(result.final_patient_reply, "Уточню детали с командой клиники — один момент.");
  assert.equal((result.debug as any).reason, "bounded_tool_batch_budget_exhausted");
  assert.equal(c, 3, "failed second-batch output is still returned to one bounded final model step");
});

test("M1: bounded third call is protocol-safe — second-batch tool_results in the active conversation", async () => {
  let c = 0;
  let round3Input: Parameters<RuntimeAgentCaller>[0] | undefined;
  const caller: RuntimeAgentCaller = async (inp) => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "hours" }, call_id: "c1" }], conversation_id: "conv_main" };
    if (c === 2) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "book" }, call_id: "c2" }], conversation_id: "conv_main" };
    round3Input = inp;
    return { type: "final_response", final_response: { final_patient_reply: "Answer." } };
  };
  await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "c1", text: "9-17" }] } }) },
  }).runTurn(makeInput());

  assert.ok(round3Input !== undefined, "round 3 must be called");
  assert.deepEqual(
    round3Input!.input.tool_results?.map((item) => item.call_id),
    ["c2"],
    "round 3 must resolve exactly the pending second-batch call",
  );
  assert.equal(round3Input!.conversation_id, "conv_main", "round 3 must continue the active conversation");
  assert.equal(round3Input!.input.tool_definitions, undefined, "round 3 must have no tool_definitions");
  assert.ok(
    round3Input!.input.context != null && !("resolved_context" in round3Input!.input.context),
    "protocol-resolved second-batch outputs must not be duplicated as resolved_context",
  );
});

test("M1: bounded final response keeps the resolved active conversation resumable", async () => {
  let c = 0;
  const caller: RuntimeAgentCaller = async () => {
    c++;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "q" }, call_id: "c1" }], conversation_id: "conv_r1" };
    if (c === 2) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "q2" }, call_id: "c2" }], conversation_id: "conv_r2" };
    return { type: "final_response", final_response: { final_patient_reply: "Answer" }, conversation_id: "conv_r2" };
  };
  const result = await createRuntimeAgentLoop({
    model: "m",
    caller,
    executors: { "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "c1", text: "info" }] } }) },
  }).runTurn(makeInput());

  assert.equal(result.conversation_id, "conv_r2", "resolved second-batch conversation remains active");
  assert.notEqual(result.conversation_id_resumable, false);
});

test("safety: forced finalization does not call booking.confirm, hold.create, or notification RPCs", async () => {
  let c = 0;
  const forbiddenCalls: string[] = [];
  const caller: RuntimeAgentCaller = async () => {
    c += 1;
    if (c === 1) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "чистка" } }] };
    if (c === 2) return { type: "tool_requests", tool_requests: [{ tool: "kb.search", arguments: { query: "запись" } }] };
    return { type: "final_response", final_response: { final_patient_reply: "Ответ." } };
  };
  const executors: ToolExecutorRegistry = {
    "kb.search": async () => ({ tool: "kb.search", status: "success", data: { chunks: [{ chunk_id: "c1", text: "info" }] } }),
    "booking.confirm": async () => { forbiddenCalls.push("booking.confirm"); return { tool: "booking.confirm", status: "success", data: {} }; },
    "hold.create": async () => { forbiddenCalls.push("hold.create"); return { tool: "hold.create", status: "success", data: {} }; },
  };
  await createRuntimeAgentLoop({ model: "m", caller, executors }).runTurn(makeInput());
  assert.deepEqual(forbiddenCalls, [], "no booking/hold/notification executors must be called during forced finalization");
});

// ── E2E subject_intent extraction through runtime loop ────────────────────────

test("loop-SI-1: valid subject_intent without reply survives runtime loop — not intercepted as malformed", async () => {
  // Model returns JSON with valid intent but no reply field.
  // normalizeOpenAIResponse must classify this as subject_intent_reply_missing (not malformed),
  // so isMalformedFinalResponse() does NOT intercept it in runtimeAgentLoop.
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    final_response: {
      final_patient_reply: "Sorry, I'm having trouble processing that right now. Please try again in a moment.",
      subject_intent: { action: "switch_subject", target: "self", confidence: "high" },
      safety_notes: ["subject_intent_reply_missing"],
    },
    conversation_id: "conv_si5",
  });

  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput());

  assert.ok(result.final_patient_reply.length > 0, "patient must receive a reply");
  assert.equal(result.subject_intent?.action, "switch_subject", "subject_intent must reach RuntimeAgentTurnResult");
  assert.equal(result.subject_intent?.target, "self");
  // conversation_id must be preserved (not marked dirty)
  assert.equal(result.conversation_id, "conv_si5");
});

test("loop-SI-2: truly malformed output (no text, no intent) remains malformed and localized", async () => {
  // Model returns empty reply with malformed_openai_response — existing behavior must be unchanged.
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    final_response: {
      final_patient_reply: "",
      safety_notes: ["malformed_openai_response"],
    },
    conversation_id: "conv_si6",
  });

  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn({ ...makeInput(), locale: "ru" });

  assert.ok(result.final_patient_reply.length > 0, "localized fallback must be non-empty");
  // Malformed path must NOT produce a subject_intent
  assert.equal(result.subject_intent, undefined, "truly malformed response must not carry subject_intent");
});

test("loop-SI-3: JSON with reply and intent reaches runtime loop intact", async () => {
  // Model returns caller-processed result: reply extracted, intent extracted.
  // Runtime loop must propagate both without modification.
  const caller: RuntimeAgentCaller = async () => ({
    type: "final_response",
    final_response: {
      final_patient_reply: "Хорошо, уточним данные для вашей мамы.",
      subject_intent: {
        action: "create_subjects",
        target: "mentioned_person",
        count: 1,
        labels: ["мама"],
        display_name: "Анна",
        confidence: "high",
      },
    },
    conversation_id: "conv_si7",
  });

  const agent = createRuntimeAgentLoop({ model: "gpt-test", caller, executors: {} });
  const result = await agent.runTurn(makeInput());

  assert.equal(result.final_patient_reply, "Хорошо, уточним данные для вашей мамы.", "raw JSON must never be patient text");
  assert.equal(result.subject_intent?.action, "create_subjects");
  assert.equal(result.subject_intent?.labels?.[0], "мама");
  assert.equal(result.subject_intent?.display_name, "Анна");
});

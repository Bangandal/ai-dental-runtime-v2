import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDentalRuntimeAgent } from "../src/runtime/dentalRuntimeAgentFactory.ts";
import type { OpenAIResponsesClient } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import type { ConversationMemoryRepository } from "../src/runtime/runtimeRepositories.ts";

function makeTurnInput() {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    user_message: "Can you help me?",
    locale: "en",
    truth_snapshot: { scheduling_intent_present: true, date_or_time_present: true },
  };
}

test("factory returns object with runTurn function", () => {
  const agent = createDentalRuntimeAgent({
    model: "gpt-test",
    openaiClient: { responses: { create: async () => ({ output_text: "ok" }) } },
    rpc: async () => ({ data: null, error: null }),
  });

  assert.equal(typeof agent.runTurn, "function");
});

test("OpenAI caller receives active tool definitions only", async () => {
  let captured: Record<string, unknown> | undefined;
  const agent = createDentalRuntimeAgent({
    model: "gpt-test",
    openaiClient: {
      responses: {
        create: async (input: unknown) => {
          captured = input as Record<string, unknown>;
          return { output_text: "Done" };
        },
      },
    },
    rpc: async () => ({ data: null, error: null }),
  });

  await agent.runTurn(makeTurnInput());
  const toolNames = ((captured?.tools ?? []) as Array<Record<string, unknown>>).map((tool) => String(tool.name));

  assert.deepEqual(toolNames.sort(), ["availability_check", "kb_search"]);
});

test("kb.search path executes RPC and returns final response", async () => {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let callCount = 0;
  const openaiClient: OpenAIResponsesClient = {
    responses: {
      create: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            tool_calls: [{ name: "kb_search", arguments: JSON.stringify({ query: "insurance" }), call_id: "call_1" }],
          };
        }
        return { output_text: "We accept PPO." };
      },
    },
  };

  const agent = createDentalRuntimeAgent({
    model: "gpt-test",
    openaiClient,
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      return {
        data: [{ chunk_id: "k1", text: "We accept PPO" }],
        error: null,
      };
    },
  });

  const result = await agent.runTurn(makeTurnInput());

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]?.fn, "core.rpc_kb_search_v1");
  assert.equal(result.final_patient_reply, "We accept PPO.");
});

test("availability.check path executes RPC and returns final response", async () => {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let callCount = 0;

  const agent = createDentalRuntimeAgent({
    model: "gpt-test",
    openaiClient: {
      responses: {
        create: async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              tool_calls: [{ name: "availability_check", arguments: { requested_date: "2026-05-23" }, call_id: "call_2" }],
            };
          }
          return { output_text: "We have openings tomorrow." };
        },
      },
    },
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      return {
        data: [{ slot_key: "slot_1", starts_at: "2026-05-23T10:00:00Z", ends_at: "2026-05-23T10:30:00Z", timezone: "UTC" }],
        error: null,
      };
    },
  });

  const result = await agent.runTurn(makeTurnInput());

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]?.fn, "core.rpc_check_availability_v1");
  assert.equal(result.final_patient_reply, "We have openings tomorrow.");
});

test("future tools are not wired, so no executor/RPC path runs", async () => {
  const rpcCalls: string[] = [];
  let callCount = 0;

  const agent = createDentalRuntimeAgent({
    model: "gpt-test",
    openaiClient: {
      responses: {
        create: async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              tool_calls: [{ name: "booking.confirm", arguments: { hold_id: "h1" }, call_id: "call_3" }],
            };
          }
          return { output_text: "I can’t confirm bookings here." };
        },
      },
    },
    rpc: async (fn) => {
      rpcCalls.push(fn);
      return { data: null, error: null };
    },
  });

  const result = await agent.runTurn(makeTurnInput());

  assert.equal(rpcCalls.length, 0);
  assert.deepEqual(result.tool_results, []);
  assert.match(result.final_patient_reply, /having trouble processing/i);
});

test("memory repository is used for load and save and failures are non-fatal", async () => {
  const calls: string[] = [];
  const memoryRepository: ConversationMemoryRepository = {
    async getConversationMemory() {
      calls.push("load");
      return { ok: true, data: { conversation_id: "conv_mem_1" } };
    },
    async saveConversationMemory(input) {
      calls.push(`save:${input.conversation_id}`);
      return { ok: false, error: { code: "mem_failed", message: "failed", retryable: false } };
    },
  };

  const agent = createDentalRuntimeAgent({
    model: "gpt-test",
    openaiClient: {
      responses: {
        create: async () => ({ output_text: "Done", conversation_id: "conv_new_1" }),
      },
    },
    rpc: async () => ({ data: null, error: null }),
    conversationMemoryRepository: memoryRepository,
  });

  const result = await agent.runTurn({ ...makeTurnInput(), conversation_id: undefined });

  assert.deepEqual(calls, ["load", "save:conv_new_1"]);
  assert.equal((result.debug as Record<string, unknown>).memory_saved, false);
  assert.equal(result.final_patient_reply, "Done");
});

test("factory module has no forbidden imports", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/dentalRuntimeAgentFactory.ts");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*calendar[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*mcp[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["']openai["']/i);
});

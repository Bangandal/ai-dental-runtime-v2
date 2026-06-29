import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDentalRuntimeTurnService,
  createRuntimeTurnService,
  normalizeRuntimeTurnResult,
} from "../src/runtime/runtimeTurnService.ts";
import type { OpenAIRuntimeAgent } from "../src/runtime/openaiRuntimeAgent.ts";

function makeInput() {
  return {
    trace_id: "trace_1",
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    conversation_id: "conv_1",
    user_message: "Can you help me book?",
    locale: "en",
    business_context: { channel: "web" },
    truth_snapshot: { scheduling_intent_present: true },
    recent_summary: "Asked about booking",
  };
}

test("runTurn delegates to injected agent and returns final_patient_reply", async () => {
  const calls: unknown[] = [];
  const agent: OpenAIRuntimeAgent = {
    async runTurn(input) {
      calls.push(input);
      return {
        final_patient_reply: "Sure, I can help.",
        tool_requests: [],
        tool_results: [],
      };
    },
  };

  const service = createRuntimeTurnService({ agent });
  const result = await service.runTurn(makeInput());

  assert.equal(calls.length, 1);
  assert.equal(result.final_patient_reply, "Sure, I can help.");
});

test("preserves conversation_id, tool_requests, tool_results, and debug", async () => {
  const service = createRuntimeTurnService({
    agent: {
      runTurn: async () => ({
        final_patient_reply: "Here are options.",
        conversation_id: "conv_2",
        tool_requests: [{ tool: "kb.search", arguments: { query: "cleaning price" }, call_id: "c1" }],
        tool_results: [{ tool: "kb.search", status: "success", call_id: "c1", data: { chunks: [] } }],
        debug: { trace_id: "trace_2" },
      }),
    },
  });

  const result = await service.runTurn(makeInput());

  assert.equal(result.conversation_id, "conv_2");
  assert.equal(result.tool_requests[0]?.tool, "kb.search");
  assert.equal(result.tool_results[0]?.status, "success");
  assert.equal((result.debug as Record<string, unknown>).trace_id, "trace_2");
});

test("does not mutate input", async () => {
  const input = makeInput();
  const before = structuredClone(input);

  const service = createRuntimeTurnService({
    agent: {
      runTurn: async () => ({
        final_patient_reply: "Reply",
        tool_requests: [],
        tool_results: [],
      }),
    },
  });

  await service.runTurn(input);

  assert.deepEqual(input, before);
});

test("final_patient_reply is required", async () => {
  const service = createRuntimeTurnService({
    agent: {
      runTurn: async () => ({
        final_patient_reply: "   ",
        tool_requests: [],
        tool_results: [],
      }),
    },
  });

  await assert.rejects(() => service.runTurn(makeInput()), /runtime_turn_result_missing_final_patient_reply/);
});

test("normalizeRuntimeTurnResult: ui is passed through when present", () => {
  const result = normalizeRuntimeTurnResult({
    final_patient_reply: "Поделитесь номером.",
    tool_requests: [],
    tool_results: [],
    ui: { telegram: { request_contact: true, button_text: "📞 Поделиться номером" } },
  });
  assert.equal(result.ui?.telegram?.request_contact, true);
  assert.equal(result.ui?.telegram?.button_text, "📞 Поделиться номером");
});

test("normalizeRuntimeTurnResult: ui is absent when not provided", () => {
  const result = normalizeRuntimeTurnResult({
    final_patient_reply: "Чем помочь?",
    tool_requests: [],
    tool_results: [],
  });
  assert.equal(result.ui, undefined);
});

test("createDentalRuntimeTurnService: ui.telegram from model JSON is preserved end-to-end", async () => {
  const service = createDentalRuntimeTurnService({
    model: "gpt-test",
    openaiClient: {
      responses: {
        create: async () => ({
          final_response: {
            final_patient_reply: "Поделитесь номером телефона кнопкой ниже.",
            ui: {
              telegram: {
                request_contact: true,
                button_text: "📞 Поделиться номером",
              },
            },
          },
        }),
      },
    },
    rpc: async () => ({ data: null, error: null }),
  });

  const result = await service.runTurn({
    trace_id: "trace_ui",
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    conversation_id: "conv_1",
    user_message: "Запишите меня",
    locale: "ru",
  });

  assert.equal(result.final_patient_reply, "Поделитесь номером телефона кнопкой ниже.");
  assert.equal(result.ui?.telegram?.request_contact, true);
  assert.equal(result.ui?.telegram?.button_text, "📞 Поделиться номером");
});

test("service module has no forbidden external imports", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/runtimeTurnService.ts");
  const source = await readFile(modulePath, "utf8");

  assert.doesNotMatch(source, /from\s+["']openai["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*supabase[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*n8n[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*telegram[^"']*["']/i);
  assert.doesNotMatch(source, /from\s+["'][^"']*calendar[^"']*["']/i);
});

test("createDentalRuntimeTurnService wires dental runtime agent and keeps active tools only", async () => {
  let capturedToolNames: string[] = [];
  const service = createDentalRuntimeTurnService({
    model: "gpt-test",
    openaiClient: {
      responses: {
        create: async (input: unknown) => {
          const payload = input as Record<string, unknown>;
          capturedToolNames = ((payload.tools ?? []) as Array<Record<string, unknown>>).map((tool) => String(tool.name));
          return { output_text: "All set." };
        },
      },
    },
    rpc: async () => ({ data: null, error: null }),
  });

  const result = await service.runTurn(makeInput());

  assert.equal(result.final_patient_reply, "All set.");
  assert.deepEqual(capturedToolNames.sort(), ["availability_check", "kb_search"]);
  assert.equal(capturedToolNames.includes("booking.confirm"), false);
});

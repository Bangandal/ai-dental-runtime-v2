import assert from "node:assert/strict";
import test from "node:test";

import { createKbSearchExecutor } from "../src/runtime/kbSearchExecutor.ts";
import type { RuntimeResult } from "../src/runtime/runtimeRepositories.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

const BASE_CONTEXT: ToolExecutionContext = {
  clinic_id: "clinic_1",
  query_text: "what are your hours?",
  locale: "en-US",
  limit: 4,
};

test("kb executor fails if clinic_id missing and does not call repository", async () => {
  let repositoryCalled = false;
  const executor = createKbSearchExecutor({
    knowledgeRepository: {
      async searchKnowledge() {
        repositoryCalled = true;
        return { ok: true, data: { chunks: [] } };
      },
    },
  });

  const result = await executor({ ...BASE_CONTEXT, clinic_id: undefined });

  assert.equal(repositoryCalled, false);
  assert.equal(result.tool, "kb.search");
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "kb_missing_clinic_id");
});

test("kb executor fails if query missing and does not call repository", async () => {
  let repositoryCalled = false;
  const executor = createKbSearchExecutor({
    knowledgeRepository: {
      async searchKnowledge() {
        repositoryCalled = true;
        return { ok: true, data: { chunks: [] } };
      },
    },
  });

  const result = await executor({ ...BASE_CONTEXT, query_text: "  " });

  assert.equal(repositoryCalled, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "kb_missing_query");
});



test("kb executor does not fall back to planner booking_request.service for query", async () => {
  let repositoryCalled = false;
  const executor = createKbSearchExecutor({
    knowledgeRepository: {
      async searchKnowledge() {
        repositoryCalled = true;
        return { ok: true, data: { chunks: [] } };
      },
    },
  });

  const result = await executor({
    ...BASE_CONTEXT,
    query_text: " ",
    planner: {
      turn_type: "booking",
      confidence: "high",
      tools_requested: ["kb.search"],
      reply_strategy: "answer_only",
      booking_action: "check_availability",
      booking_request: { service: "cleaning" },
    },
  });

  assert.equal(repositoryCalled, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "kb_missing_query");
});

test("kb executor calls repository with normalized args", async () => {
  let receivedInput: unknown;
  const executor = createKbSearchExecutor({
    knowledgeRepository: {
      async searchKnowledge(input) {
        receivedInput = input;
        return { ok: true, data: { chunks: [] } };
      },
    },
  });

  await executor({ ...BASE_CONTEXT, query_text: "  does insurance cover x-rays?  " });

  assert.deepEqual(receivedInput, {
    clinic_id: "clinic_1",
    query: "does insurance cover x-rays?",
    limit: 4,
    locale: "en-US",
  });
});

test("kb executor returns chunks on success", async () => {
  const executor = createKbSearchExecutor({
    knowledgeRepository: {
      async searchKnowledge(): Promise<RuntimeResult<{ chunks: Array<{ chunk_id: string; text: string }> }>> {
        return { ok: true, data: { chunks: [{ chunk_id: "chunk_1", text: "We are open Mon-Fri 8am-5pm." }] } };
      },
    },
  });

  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data, {
    chunks: [{ chunk_id: "chunk_1", text: "We are open Mon-Fri 8am-5pm." }],
  });
});

test("kb executor preserves repository failure", async () => {
  const executor = createKbSearchExecutor({
    knowledgeRepository: {
      async searchKnowledge() {
        return { ok: false, error: { code: "kb_backend_unavailable", message: "backend unavailable", retryable: true } };
      },
    },
  });

  const result = await executor(BASE_CONTEXT);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, { code: "kb_backend_unavailable", message: "backend unavailable", retryable: true });
});

test("kb executor module does not import forbidden integrations and side-effect paths", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/runtime/kbSearchExecutor.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /openai|supabase|n8n|telegram|calendar/i);
  assert.doesNotMatch(source, /createHold|confirmBooking|cancelHold|checkAvailability|admin\.notify/i);
});

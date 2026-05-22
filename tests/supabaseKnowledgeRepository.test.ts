import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseKnowledgeRepository, type RpcCaller } from "../src/runtime/supabaseKnowledgeRepository.ts";

test("calls core.rpc_kb_search_v1 with mapped arguments", async () => {
  let calledName = "";
  let calledArgs: Record<string, unknown> | null = null;

  const rpc: RpcCaller = async (functionName, args) => {
    calledName = functionName;
    calledArgs = args;
    return { data: [], error: null };
  };

  const repo = createSupabaseKnowledgeRepository({ rpc });
  await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours", limit: 5, locale: "en-US" });

  assert.equal(calledName, "core.rpc_kb_search_v1");
  assert.deepEqual(calledArgs, {
    p_clinic_id: "clinic_1",
    p_query: "hours",
    p_limit: 5,
    p_locale: "en-US",
  });
});

test("normalizes rows into RpcKnowledgeChunk[]", async () => {
  const rpc: RpcCaller = async () => ({
    data: [{ chunk_id: "chunk_1", document_id: "doc_1", score: 0.88, text: "Office hours", metadata: { locale: "en-US" } }],
    error: null,
  });

  const repo = createSupabaseKnowledgeRepository({ rpc });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data.chunks, [{ chunk_id: "chunk_1", document_id: "doc_1", score: 0.88, text: "Office hours", metadata: { locale: "en-US" } }]);
  }
});

test("returns empty chunks on null data", async () => {
  const rpc: RpcCaller = async () => ({ data: null, error: null });
  const repo = createSupabaseKnowledgeRepository({ rpc });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.deepEqual(result, { ok: true, data: { chunks: [] } });
});

test("returns failure on RPC error", async () => {
  const rpc: RpcCaller = async () => ({ data: null, error: new Error("boom") });
  const repo = createSupabaseKnowledgeRepository({ rpc });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "kb_rpc_error");
    assert.equal(result.error.retryable, true);
  }
});

test("fails malformed rows", async () => {
  const rpc: RpcCaller = async () => ({ data: [{ text: "missing chunk_id" }], error: null });
  const repo = createSupabaseKnowledgeRepository({ rpc });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "kb_rpc_malformed_response");
  }
});

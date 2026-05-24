import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseKnowledgeRepository, type RpcCaller } from "../src/runtime/supabaseKnowledgeRepository.ts";

test("creates embedding then calls rpc_kb_search_v1 with vector arguments", async () => {
  let calledName = "";
  let calledArgs: Record<string, unknown> | null = null;

  const rpc: RpcCaller = async (functionName, args) => {
    calledName = functionName;
    calledArgs = args;
    return { data: [], error: null };
  };

  let embeddingInput: { model: string; text: string } | null = null;
  const repo = createSupabaseKnowledgeRepository({
    rpc,
    embeddingModel: "text-embedding-3-small",
    embeddingClient: {
      async createEmbedding(input) {
        embeddingInput = input;
        return [0.12, 0.34];
      },
    },
  });
  await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours", limit: 5, locale: "en-US" });

  assert.deepEqual(embeddingInput, { model: "text-embedding-3-small", text: "hours" });
  assert.equal(calledName, "public.rpc_kb_search_v1");
  assert.deepEqual(calledArgs, {
    p_clinic_id: "clinic_1",
    p_query_vec: [0.12, 0.34],
    p_k: 5,
    p_min_similarity: 0.2,
  });
});

test("normalizes rows into RpcKnowledgeChunk[]", async () => {
  const rpc: RpcCaller = async () => ({
    data: [{ chunk_id: "chunk_1", document_id: "doc_1", score: 0.88, text: "Office hours", metadata: { locale: "en-US" } }],
    error: null,
  });

  const repo = createSupabaseKnowledgeRepository({ rpc, embeddingModel: "m", embeddingClient: { createEmbedding: async () => [0.1] } });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data.chunks, [{ chunk_id: "chunk_1", document_id: "doc_1", score: 0.88, text: "Office hours", metadata: { locale: "en-US" } }]);
  }
});

test("returns empty chunks on null data", async () => {
  const rpc: RpcCaller = async () => ({ data: null, error: null });
  const repo = createSupabaseKnowledgeRepository({ rpc, embeddingModel: "m", embeddingClient: { createEmbedding: async () => [0.1] } });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.deepEqual(result, { ok: true, data: { chunks: [] } });
});

test("returns failure on RPC error", async () => {
  const rpc: RpcCaller = async () => ({ data: null, error: new Error("boom") });
  const repo = createSupabaseKnowledgeRepository({ rpc, embeddingModel: "m", embeddingClient: { createEmbedding: async () => [0.1] } });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "kb_rpc_error");
    assert.equal(result.error.retryable, true);
  }
});



test("supports JSON object response with empty hits", async () => {
  const rpc: RpcCaller = async () => ({ data: { hits: [], count: 0, context_text: "", top_similarity: null }, error: null });
  const repo = createSupabaseKnowledgeRepository({ rpc, embeddingModel: "m", embeddingClient: { createEmbedding: async () => [0.1] } });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.deepEqual(result, { ok: true, data: { chunks: [] } });
});

test("supports JSON object response with hits and normalizes fields", async () => {
  const rpc: RpcCaller = async () => ({
    data: {
      hits: [{ id: "chunk_2", document_id: "doc_2", similarity: 0.73, content: "Emergency policy" }],
      count: 1,
      context_text: "Emergency policy",
      top_similarity: 0.73,
    },
    error: null,
  });

  const repo = createSupabaseKnowledgeRepository({ rpc, embeddingModel: "m", embeddingClient: { createEmbedding: async () => [0.1] } });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "emergency" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data.chunks, [{ chunk_id: "chunk_2", document_id: "doc_2", score: 0.73, text: "Emergency policy", metadata: undefined }]);
  }
});
test("fails malformed rows", async () => {
  const rpc: RpcCaller = async () => ({ data: [{ text: "missing chunk_id" }], error: null });
  const repo = createSupabaseKnowledgeRepository({ rpc, embeddingModel: "m", embeddingClient: { createEmbedding: async () => [0.1] } });
  const result = await repo.searchKnowledge({ clinic_id: "clinic_1", query: "hours" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "kb_rpc_malformed_response");
  }
});

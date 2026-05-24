import type { KnowledgeRepository, RpcKnowledgeChunk, RuntimeResult } from "./runtimeRepositories.ts";

export type RpcCaller = <TResult>(
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: TResult | null; error: unknown | null }>;

export interface EmbeddingClient {
  createEmbedding(input: {
    model: string;
    text: string;
  }): Promise<number[]>;
}

interface RpcKnowledgeRow {
  chunk_id?: unknown;
  id?: unknown;
  document_id?: unknown;
  score?: unknown;
  similarity?: unknown;
  text?: unknown;
  content?: unknown;
  metadata?: unknown;
}

interface RpcKnowledgeJsonResponse {
  hits?: unknown;
  count?: unknown;
  context_text?: unknown;
  top_similarity?: unknown;
}

function malformedResponse(details?: Record<string, unknown>): RuntimeResult<{ chunks: RpcKnowledgeChunk[] }> {
  return {
    ok: false,
    error: {
      code: "kb_rpc_malformed_response",
      message: "Knowledge RPC returned malformed rows",
      retryable: false,
      details,
    },
  };
}

function normalizeChunk(row: RpcKnowledgeRow, index: number): RuntimeResult<RpcKnowledgeChunk, "kb_rpc_malformed_response"> {
  const chunkId = typeof row.chunk_id === "string" ? row.chunk_id : typeof row.id === "string" ? row.id : null;
  const text = typeof row.text === "string" ? row.text : typeof row.content === "string" ? row.content : null;
  const score = typeof row.score === "number" ? row.score : typeof row.similarity === "number" ? row.similarity : undefined;

  if (chunkId == null || text == null) {
    return {
      ok: false,
      error: {
        code: "kb_rpc_malformed_response",
        message: "Knowledge row missing required fields",
        retryable: false,
        details: { index },
      },
    };
  }

  return {
    ok: true,
    data: {
      chunk_id: chunkId,
      document_id: typeof row.document_id === "string" ? row.document_id : null,
      score,
      text,
      metadata: typeof row.metadata === "object" && row.metadata !== null ? row.metadata as Record<string, unknown> : undefined,
    },
  };
}

export function createSupabaseKnowledgeRepository(
  deps: { rpc: RpcCaller; embeddingClient: EmbeddingClient; embeddingModel: string },
): Pick<KnowledgeRepository, "searchKnowledge"> {
  return {
    async searchKnowledge(input) {
      const queryVector = await deps.embeddingClient.createEmbedding({
        model: deps.embeddingModel,
        text: input.query,
      });

      const response = await deps.rpc<RpcKnowledgeRow[] | RpcKnowledgeJsonResponse>("public.rpc_kb_search_v1", {
        p_clinic_id: input.clinic_id,
        p_query_vec: queryVector,
        p_k: input.limit ?? null,
        p_min_similarity: 0.2,
      });

      if (response.error) {
        return {
          ok: false,
          error: {
            code: "kb_rpc_error",
            message: "Failed to search knowledge via RPC",
            retryable: true,
            details: { rpc: "public.rpc_kb_search_v1" },
          },
        };
      }

      if (response.data == null) {
        return { ok: true, data: { chunks: [] } };
      }

      let rows: RpcKnowledgeRow[];
      if (Array.isArray(response.data)) {
        rows = response.data;
      } else if (typeof response.data === "object" && response.data !== null && "hits" in response.data) {
        const hits = (response.data as RpcKnowledgeJsonResponse).hits;
        if (!Array.isArray(hits)) {
          return malformedResponse({ reason: "hits_not_array" });
        }
        rows = hits as RpcKnowledgeRow[];
      } else {
        return malformedResponse({ reason: "response_not_supported_shape" });
      }

      const chunks: RpcKnowledgeChunk[] = [];
      for (const [index, row] of rows.entries()) {
        const normalized = normalizeChunk(row, index);
        if (!normalized.ok) {
          return malformedResponse({ index });
        }
        chunks.push(normalized.data);
      }

      return { ok: true, data: { chunks } };
    },
  };
}

import type { KnowledgeRepository, RpcKnowledgeChunk, RuntimeResult } from "./runtimeRepositories.ts";

export type RpcCaller = <TResult>(
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: TResult | null; error: unknown | null }>;

interface RpcKnowledgeRow {
  chunk_id?: unknown;
  document_id?: unknown;
  score?: unknown;
  text?: unknown;
  metadata?: unknown;
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
  if (typeof row.chunk_id !== "string" || typeof row.text !== "string") {
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
      chunk_id: row.chunk_id,
      document_id: typeof row.document_id === "string" ? row.document_id : null,
      score: typeof row.score === "number" ? row.score : undefined,
      text: row.text,
      metadata: typeof row.metadata === "object" && row.metadata !== null ? row.metadata as Record<string, unknown> : undefined,
    },
  };
}

export function createSupabaseKnowledgeRepository(deps: { rpc: RpcCaller }): Pick<KnowledgeRepository, "searchKnowledge"> {
  return {
    async searchKnowledge(input) {
      const response = await deps.rpc<RpcKnowledgeRow[]>("core.rpc_kb_search_v1", {
        p_clinic_id: input.clinic_id,
        p_query: input.query,
        p_limit: input.limit ?? null,
        p_locale: input.locale ?? null,
      });

      if (response.error) {
        return {
          ok: false,
          error: {
            code: "kb_rpc_error",
            message: "Failed to search knowledge via RPC",
            retryable: true,
            details: { rpc: "core.rpc_kb_search_v1" },
          },
        };
      }

      if (response.data == null) {
        return { ok: true, data: { chunks: [] } };
      }

      if (!Array.isArray(response.data)) {
        return malformedResponse({ reason: "response_not_array" });
      }

      const chunks: RpcKnowledgeChunk[] = [];
      for (const [index, row] of response.data.entries()) {
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

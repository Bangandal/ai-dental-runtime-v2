import type { KnowledgeRepository } from "./runtimeRepositories.ts";
import type { ToolExecutionContext, ToolExecutor } from "./toolExecutor.ts";
import { makeFailedToolResult } from "./toolResults.ts";

export interface KbSearchExecutorDeps {
  knowledgeRepository: Pick<KnowledgeRepository, "searchKnowledge">;
}

function resolveKbQuery(context: ToolExecutionContext): string {
  const direct = typeof context.query_text === "string" ? context.query_text : "";
  if (direct.trim().length > 0) {
    return direct.trim();
  }

  const fromPlanner = context.planner?.booking_request?.service;
  if (typeof fromPlanner === "string" && fromPlanner.trim().length > 0) {
    return fromPlanner.trim();
  }

  return "";
}

export function createKbSearchExecutor(deps: KbSearchExecutorDeps): ToolExecutor {
  return async (context: ToolExecutionContext) => {
    const clinicId = context.clinic_id;
    if (!clinicId) {
      return makeFailedToolResult("kb.search", "kb_missing_clinic_id", "clinic_id is required", false);
    }

    const query = resolveKbQuery(context);
    if (!query) {
      return makeFailedToolResult("kb.search", "kb_missing_query", "query is required", false);
    }

    const repositoryResult = await deps.knowledgeRepository.searchKnowledge({
      clinic_id: clinicId,
      query,
      limit: context.limit,
      locale: context.locale ?? null,
    });

    if (!repositoryResult.ok) {
      return makeFailedToolResult(
        "kb.search",
        repositoryResult.error.code,
        repositoryResult.error.message,
        repositoryResult.error.retryable,
      );
    }

    return {
      tool: "kb.search",
      status: "success",
      data: {
        chunks: repositoryResult.data.chunks,
      },
    };
  };
}

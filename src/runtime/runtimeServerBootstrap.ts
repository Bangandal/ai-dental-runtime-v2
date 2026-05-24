import { registerRuntimeTurnRoute, type RouteRegistrationApp } from "./runtimeTurnHttpRoute.ts";
import { createDentalRuntimeTurnService } from "./runtimeTurnService.ts";
import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { RpcCaller } from "./runtimeRepositories.ts";
import type { EmbeddingClient } from "./supabaseKnowledgeRepository.ts";
import { createNoopRuntimeTurnLogger, type RuntimeTurnLogger } from "./runtimeTurnLogger.ts";
import { createSupabaseOpenAIConversationMemoryRepository } from "./supabaseOpenAIConversationMemoryRepository.ts";
import { createSupabaseTurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";

export interface RuntimeServerBootstrapDeps {
  openaiClient: OpenAIResponsesClient;
  model: string;
  embeddingModel: string;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  runtimeTurnLogger?: RuntimeTurnLogger;
}


function readConversationId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export function registerRuntimeRoutes(app: RouteRegistrationApp, deps: RuntimeServerBootstrapDeps): void {
  const openAIConversationMemoryRepository = createSupabaseOpenAIConversationMemoryRepository({ rpc: deps.rpc });
  const turnPersistenceRepository = createSupabaseTurnPersistenceRepository({ rpc: deps.rpc });
  const createOpenAIConversation = async (): Promise<string | null> => {
    const conversations = (deps.openaiClient as unknown as {
      conversations?: { create?: () => Promise<unknown> };
    }).conversations;

    if (typeof conversations?.create !== "function") {
      return null;
    }

    const created = await conversations.create();
    return readConversationId(created);
  };

  registerRuntimeTurnRoute(app, {
    runtimeTurnService: createDentalRuntimeTurnService({
      openaiClient: deps.openaiClient,
      model: deps.model,
      embeddingModel: deps.embeddingModel,
      rpc: deps.rpc,
      embeddingClient: deps.embeddingClient,
    }),
    runtimeTurnLogger: deps.runtimeTurnLogger ?? createNoopRuntimeTurnLogger(),
    openAIConversationMemoryRepository,
    createOpenAIConversation,
    turnPersistenceRepository,
  });
}

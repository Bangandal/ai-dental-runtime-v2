import { registerRuntimeTurnRoute, type RouteRegistrationApp } from "./runtimeTurnHttpRoute.ts";
import { createDentalRuntimeTurnService } from "./runtimeTurnService.ts";
import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { RpcCaller } from "./runtimeRepositories.ts";
import type { EmbeddingClient } from "./supabaseKnowledgeRepository.ts";
import { createNoopRuntimeTurnLogger, type RuntimeTurnLogger } from "./runtimeTurnLogger.ts";

export interface RuntimeServerBootstrapDeps {
  openaiClient: OpenAIResponsesClient;
  model: string;
  embeddingModel: string;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  runtimeTurnLogger?: RuntimeTurnLogger;
}

export function registerRuntimeRoutes(app: RouteRegistrationApp, deps: RuntimeServerBootstrapDeps): void {
  registerRuntimeTurnRoute(app, {
    runtimeTurnService: createDentalRuntimeTurnService({
      openaiClient: deps.openaiClient,
      model: deps.model,
      embeddingModel: deps.embeddingModel,
      rpc: deps.rpc,
      embeddingClient: deps.embeddingClient,
    }),
    runtimeTurnLogger: deps.runtimeTurnLogger ?? createNoopRuntimeTurnLogger(),
  });
}

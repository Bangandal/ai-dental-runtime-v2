import { registerRuntimeTurnRoute, type RouteRegistrationApp } from "./runtimeTurnHttpRoute.ts";
import { registerTelegramWebhookRoute, type TelegramRouteApp } from "./telegramWebhookRoute.ts";
import { createRateLimiter } from "./runtimeRateLimiter.ts";
import { createDentalRuntimeTurnService } from "./runtimeTurnService.ts";
import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { RpcCaller } from "./runtimeRepositories.ts";
import type { EmbeddingClient } from "./supabaseKnowledgeRepository.ts";
import { createNoopRuntimeTurnLogger, type RuntimeTurnLogger } from "./runtimeTurnLogger.ts";
import { createSupabaseOpenAIConversationMemoryRepository } from "./supabaseOpenAIConversationMemoryRepository.ts";
import { createSupabaseTurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";
import { createSupabaseClinicIdentityResolver } from "./supabaseClinicIdentityResolver.ts";
import { createSupabaseRuntimeContextRepository } from "./supabaseRuntimeContextRepository.ts";
import { createSupabaseCaseContextRepository } from "./supabaseCaseContextRepository.ts";
import { createOpenAICaseRouterClassifier } from "./openaiCaseRouterClassifier.ts";
import { createOpenAIRuntimeGateClassifier } from "./runtimeGateShadow.ts";
import { createOpenAITurnUnderstandingClassifier } from "./turnUnderstandingShadow.ts";

export interface TelegramBootstrapConfig {
  botToken: string;
  webhookSecret: string | undefined;
  defaultClinicCode: string;
}

export interface RuntimeServerBootstrapDeps {
  openaiClient: OpenAIResponsesClient;
  model: string;
  embeddingModel: string;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  runtimeTurnLogger?: RuntimeTurnLogger;
  apiKey?: string | undefined;
  isProduction?: boolean;
  debugEnabled?: boolean;
  telegram?: TelegramBootstrapConfig;
}


function readConversationId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export function registerRuntimeRoutes(app: RouteRegistrationApp & TelegramRouteApp, deps: RuntimeServerBootstrapDeps): void {
  const caseRouterModel = process.env.OPENAI_CASE_ROUTER_MODEL?.trim() || deps.model;
  const runtimeGateModel = process.env.OPENAI_RUNTIME_GATE_MODEL?.trim() || deps.model;
  const turnUnderstandingModel = process.env.OPENAI_TURN_UNDERSTANDING_MODEL?.trim() || process.env.OPENAI_RUNTIME_GATE_MODEL?.trim() || deps.model;
  const openAIConversationMemoryRepository = createSupabaseOpenAIConversationMemoryRepository({ rpc: deps.rpc });
  const turnPersistenceRepository = createSupabaseTurnPersistenceRepository({ rpc: deps.rpc });
  const clinicIdentityResolver = createSupabaseClinicIdentityResolver({ rpc: deps.rpc });
  const runtimeContextRepository = createSupabaseRuntimeContextRepository({ rpc: deps.rpc });
  const caseContextRepository = createSupabaseCaseContextRepository({ rpc: deps.rpc });
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

  const rateLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 });

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
    clinicIdentityResolver,
    runtimeContextRepository,
    caseContextRepository,
    runtimeGateClassifier: createOpenAIRuntimeGateClassifier({ client: deps.openaiClient, model: runtimeGateModel }),
    turnUnderstandingClassifier: createOpenAITurnUnderstandingClassifier({ client: deps.openaiClient, model: turnUnderstandingModel }),
    caseRouterClassifier: createOpenAICaseRouterClassifier({ client: deps.openaiClient, model: caseRouterModel }),
    apiKey: deps.apiKey,
    isProduction: deps.isProduction,
    rateLimiter,
    debugEnabled: deps.debugEnabled,
  });

  if (deps.telegram) {
    const { botToken, webhookSecret, defaultClinicCode } = deps.telegram;
    registerTelegramWebhookRoute(app, {
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
      clinicIdentityResolver,
      runtimeContextRepository,
      caseContextRepository,
      runtimeGateClassifier: createOpenAIRuntimeGateClassifier({ client: deps.openaiClient, model: runtimeGateModel }),
      turnUnderstandingClassifier: createOpenAITurnUnderstandingClassifier({ client: deps.openaiClient, model: turnUnderstandingModel }),
      caseRouterClassifier: createOpenAICaseRouterClassifier({ client: deps.openaiClient, model: caseRouterModel }),
      debugEnabled: deps.debugEnabled,
      botToken,
      webhookSecret,
      defaultClinicCode,
      isProduction: deps.isProduction ?? false,
    });
  }
}

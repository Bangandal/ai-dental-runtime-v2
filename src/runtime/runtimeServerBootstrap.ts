import { registerRuntimeTurnRoute, type RouteRegistrationApp } from "./runtimeTurnHttpRoute.ts";
import { registerTelegramWebhookRoute, type TelegramRouteApp } from "./telegramWebhookRoute.ts";
import { createRateLimiter } from "./runtimeRateLimiter.ts";
import { createDentalRuntimeTurnService } from "./runtimeTurnService.ts";
import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { RpcCaller } from "./runtimeRepositories.ts";
import type { EmbeddingClient } from "./supabaseKnowledgeRepository.ts";
import { createNoopRuntimeTurnLogger, type RuntimeTurnLogger } from "./runtimeTurnLogger.ts";
import type { TelegramDeliveryOutcome } from "./telegramSender.ts";
import { createSupabaseOpenAIConversationMemoryRepository } from "./supabaseOpenAIConversationMemoryRepository.ts";
import { createSupabaseBookingProcessStateRepository } from "./supabaseBookingProcessStateRepository.ts";
import { createSerializedBookingProcessStateRepository } from "./serializedBookingProcessStateRepository.ts";
import { createSupabaseTurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";
import { createSupabaseClinicIdentityResolver } from "./supabaseClinicIdentityResolver.ts";
import { createSupabaseRuntimeContextRepository } from "./supabaseRuntimeContextRepository.ts";
import { createSupabaseCaseContextRepository } from "./supabaseCaseContextRepository.ts";
import { createOpenAICaseRouterClassifier } from "./openaiCaseRouterClassifier.ts";
import { createOpenAIRuntimeGateClassifier } from "./runtimeGateShadow.ts";
import { createOpenAITurnUnderstandingClassifier } from "./turnUnderstandingShadow.ts";
import { loadAdminNotifyConfig } from "../integrations/adminNotify/adminNotifyConfig.ts";
import { createAdminNotifier } from "../integrations/adminNotify/telegramAdminNotifier.ts";
import { createOpenAIRuntimeCaseLiteExtractor } from "./openaiRuntimeCaseLiteExtractor.ts";
import type { RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestrator.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import { createSupabaseStaffRequestRepository } from "./supabaseStaffRequestRepository.ts";

export interface TelegramBootstrapConfig {
  botToken: string;
  webhookSecret: string | undefined;
  defaultClinicCode: string;
}

export interface RuntimeServerBootstrapDeps {
  openaiClient: OpenAIResponsesClient;
  openaiApiKey?: string;
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

export function createDeliveryObserver(
  logger: RuntimeTurnLogger,
): (outcome: TelegramDeliveryOutcome & { trace_id: string }) => void {
  return (outcome) => {
    logger.logDelivery({
      ts: new Date().toISOString(),
      trace_id: outcome.trace_id,
      ok: outcome.ok,
      retry_count: outcome.retry_count,
      ...(outcome.error_code !== undefined ? { error_code: outcome.error_code } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error.slice(0, 300) } : {}),
    }).catch(() => {
      // never propagate logger errors to webhook
    });
  };
}

function readConversationId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export interface OrchestrationDepsInput {
  openaiClient: OpenAIResponsesClient;
  model: string;
  embeddingModel: string;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  runtimeTurnLogger?: RuntimeTurnLogger;
  debugEnabled?: boolean;
  telegram?: TelegramBootstrapConfig;
}

// Exported for use by non-Telegram transports (e.g. WhatsApp) that need the
// same shared orchestration deps without going through registerRuntimeRoutes.
export function createRuntimeOrchestrationDeps(deps: OrchestrationDepsInput): RuntimeTurnOrchestratorDeps {
  const agentFirst = isAgentFirstRuntimeEnabled();
  const openAIConversationMemoryRepository = createSupabaseOpenAIConversationMemoryRepository({ rpc: deps.rpc });
  const bookingProcessStateRepository = createSerializedBookingProcessStateRepository(
    createSupabaseBookingProcessStateRepository({ rpc: deps.rpc }),
  );
  const turnPersistenceRepository = createSupabaseTurnPersistenceRepository({ rpc: deps.rpc });
  const clinicIdentityResolver = createSupabaseClinicIdentityResolver({ rpc: deps.rpc });
  const runtimeContextRepository = createSupabaseRuntimeContextRepository({ rpc: deps.rpc });

  const createOpenAIConversation = async (): Promise<string | null> => {
    const conversations = (deps.openaiClient as unknown as {
      conversations?: { create?: () => Promise<unknown> };
    }).conversations;
    if (typeof conversations?.create !== "function") return null;
    const created = await conversations.create();
    return readConversationId(created);
  };

  const adminNotifyConfig = loadAdminNotifyConfig();
  const adminNotifier = createAdminNotifier({
    config: adminNotifyConfig,
    botToken: deps.telegram?.botToken ?? null,
  });

  const logger = deps.runtimeTurnLogger ?? createNoopRuntimeTurnLogger();
  const legacyOnlyDeps = !agentFirst
    ? {
        caseContextRepository: createSupabaseCaseContextRepository({ rpc: deps.rpc }),
        runtimeGateClassifier: createOpenAIRuntimeGateClassifier({
          client: deps.openaiClient,
          model: process.env.OPENAI_RUNTIME_GATE_MODEL?.trim() || deps.model,
        }),
        turnUnderstandingClassifier: createOpenAITurnUnderstandingClassifier({
          client: deps.openaiClient,
          model:
            process.env.OPENAI_TURN_UNDERSTANDING_MODEL?.trim()
            || process.env.OPENAI_RUNTIME_GATE_MODEL?.trim()
            || deps.model,
        }),
        caseRouterClassifier: createOpenAICaseRouterClassifier({
          client: deps.openaiClient,
          model: process.env.OPENAI_CASE_ROUTER_MODEL?.trim() || deps.model,
        }),
        caseLiteExtractor: createOpenAIRuntimeCaseLiteExtractor({
          client: deps.openaiClient,
          model: deps.model,
        }),
      }
    : {};

  return {
    runtimeTurnService: createDentalRuntimeTurnService({
      openaiClient: deps.openaiClient,
      model: deps.model,
      embeddingModel: deps.embeddingModel,
      rpc: deps.rpc,
      embeddingClient: deps.embeddingClient,
      bookingProcessStateRepository,
    }),
    runtimeTurnLogger: logger,
    openAIConversationMemoryRepository,
    createOpenAIConversation,
    turnPersistenceRepository,
    clinicIdentityResolver,
    runtimeContextRepository,
    ...legacyOnlyDeps,
    debugEnabled: deps.debugEnabled,
    adminNotifier,
    staffRequestRepository: createSupabaseStaffRequestRepository({ rpc: deps.rpc }),
  };
}

export function registerRuntimeRoutes(app: RouteRegistrationApp & TelegramRouteApp, deps: RuntimeServerBootstrapDeps): void {
  const rateLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 });
  const logger = deps.runtimeTurnLogger ?? createNoopRuntimeTurnLogger();
  const oDeps = createRuntimeOrchestrationDeps(deps);

  registerRuntimeTurnRoute(app, {
    ...oDeps,
    runtimeTurnLogger: logger,
    apiKey: deps.apiKey,
    isProduction: deps.isProduction,
    rateLimiter,
  });

  if (deps.telegram) {
    const { botToken, webhookSecret, defaultClinicCode } = deps.telegram;
    registerTelegramWebhookRoute(app, {
      ...oDeps,
      botToken,
      webhookSecret,
      defaultClinicCode,
      isProduction: deps.isProduction ?? false,
      onTelegramDelivery: createDeliveryObserver(logger),
      openaiApiKey: deps.openaiApiKey,
    });
  }
}

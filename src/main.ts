import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import OpenAI from "openai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readRuntimeServerEnv } from "./index.ts";
import { registerRuntimeRoutes, createRuntimeOrchestrationDeps } from "./runtime/runtimeServerBootstrap.ts";
import { readWhatsAppConfig } from "./runtime/whatsappConfig.ts";
import { registerWhatsAppWebhookRoute, type WhatsAppWebhookRouteDeps } from "./runtime/whatsappWebhookRoute.ts";
import type { RpcCaller } from "./runtime/runtimeRepositories.ts";
import type { EmbeddingClient } from "./runtime/supabaseKnowledgeRepository.ts";
import { createFileRuntimeTurnLogger, createNoopRuntimeTurnLogger, type RuntimeTurnLogger } from "./runtime/runtimeTurnLogger.ts";
import { bindOpenAIPerCallTimeout } from "./runtime/openaiClientTimeout.ts";
import { loadAdminNotifyConfig } from "./integrations/adminNotify/adminNotifyConfig.ts";
import { createAdminNotifier } from "./integrations/adminNotify/telegramAdminNotifier.ts";
import { createSupabaseStaffNotificationOutboxRepository } from "./runtime/supabaseStaffNotificationOutboxRepository.ts";
import { createStaffNotificationOutboxWorker } from "./runtime/staffNotificationOutboxWorker.ts";
import { createStaffNotificationOutboxLoop } from "./runtime/staffNotificationOutboxLoop.ts";
import { createSupabaseStaffInboxRepository } from "./runtime/staffInboxRepository.ts";
import { registerStaffInboxRoutes } from "./runtime/staffInboxRoute.ts";

export interface BuildRuntimeAppDeps {
  openaiClient: OpenAI;
  openaiApiKey?: string;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  model: string;
  runtimeTurnLogger?: RuntimeTurnLogger;
  apiKey?: string | undefined;
  isProduction?: boolean;
  debugEnabled?: boolean;
  telegram?: import("./runtime/runtimeServerBootstrap.ts").TelegramBootstrapConfig;
  whatsapp?: import("./runtime/whatsappConfig.ts").WhatsAppBootstrapConfig;
}

export function buildRuntimeApp(deps: BuildRuntimeAppDeps): FastifyInstance {
  const app = Fastify();

  app.get("/health", async () => ({ ok: true }));

  // WhatsApp requires raw bytes for Meta signature verification.
  // Register a raw-body content type parser in a scoped plugin so only
  // /webhooks/whatsapp routes capture raw bytes, other routes are unaffected.
  if (deps.whatsapp) {
    const wa = deps.whatsapp;
    app.register(async (scope) => {
      scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
        (req as unknown as Record<string, unknown>).rawBody = body as Buffer;
        try {
          done(null, JSON.parse((body as Buffer).toString("utf-8")));
        } catch {
          done(new Error("Invalid JSON"));
        }
      });

      const oDeps = createRuntimeOrchestrationDeps(deps);
      const waDeps: WhatsAppWebhookRouteDeps = {
        ...oDeps,
        accessToken: wa.accessToken,
        phoneNumberId: wa.phoneNumberId,
        verifyToken: wa.verifyToken,
        appSecret: wa.appSecret,
        graphApiVersion: wa.graphApiVersion,
        clinicId: wa.clinicId,
        openaiApiKey: deps.openaiApiKey,
      };

      const waRouteApp = {
        get(path: string, handler: (req: { query: Record<string, string | string[] | undefined> }, reply: FastifyReply) => Promise<void>) {
          scope.get(path, async (request: FastifyRequest, reply: FastifyReply) => {
            await handler({ query: request.query as Record<string, string | string[] | undefined> }, reply);
          });
        },
        post(path: string, handler: (req: { body: unknown; rawBody: Buffer | null; headers: Record<string, string | string[] | undefined> }, reply: FastifyReply) => Promise<void>) {
          scope.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
            const rawBody = (request as unknown as Record<string, unknown>).rawBody;
            await handler({
              body: request.body,
              rawBody: Buffer.isBuffer(rawBody) ? rawBody : null,
              headers: request.headers as Record<string, string | string[] | undefined>,
            }, reply);
          });
        },
      };

      registerWhatsAppWebhookRoute(waRouteApp, waDeps);
    });
  }

  registerRuntimeRoutes(app, {
    openaiClient: deps.openaiClient,
    openaiApiKey: deps.openaiApiKey,
    model: deps.model,
    embeddingModel: deps.embeddingModel,
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    runtimeTurnLogger: deps.runtimeTurnLogger ?? createNoopRuntimeTurnLogger(),
    apiKey: deps.apiKey,
    isProduction: deps.isProduction,
    debugEnabled: deps.debugEnabled,
    telegram: deps.telegram,
  });

  registerStaffInboxRoutes(app, {
    repository: createSupabaseStaffInboxRepository({ rpc: deps.rpc }),
    apiKey: deps.apiKey,
    isProduction: deps.isProduction,
  });

  return app;
}

function readRequiredEnv(name: "OPENAI_API_KEY" | "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY", env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createRpcClient(env: NodeJS.ProcessEnv = process.env): RpcCaller {
  const supabaseUrl = readRequiredEnv("SUPABASE_URL", env);
  const supabaseServiceRoleKey = readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY", env);
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    db: {
      schema: "core",
    },
  });

  return async <TResult>(functionName: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(functionName, args);
    return { data: (data as TResult | null) ?? null, error };
  };
}

function positiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw?.trim());
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// Explicit OpenAI client limits. The SDK default timeout (10 minutes) is far too
// long for a patient-facing turn, a hung request must fail into the existing
// caller-exception fallback path instead of stalling the conversation.
export const OPENAI_CLIENT_TIMEOUT_MS = 60_000;
export const OPENAI_CLIENT_MAX_RETRIES = 2;

export function buildOpenAIClientOptions(apiKey: string): { apiKey: string; timeout: number; maxRetries: number } {
  return { apiKey, timeout: OPENAI_CLIENT_TIMEOUT_MS, maxRetries: OPENAI_CLIENT_MAX_RETRIES };
}

export async function startRuntimeServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const openaiApiKey = readRequiredEnv("OPENAI_API_KEY", env);
  const openaiClient = bindOpenAIPerCallTimeout(new OpenAI(buildOpenAIClientOptions(openaiApiKey)));
  const runtimeEnv = readRuntimeServerEnv(env);
  const rpc = createRpcClient(env);
  const embeddingClient: EmbeddingClient = {
    async createEmbedding(input) {
      const response = await openaiClient.embeddings.create({
        model: input.model,
        input: input.text,
      });
      return response.data[0]?.embedding ?? [];
    },
  };
  const port = Number(env.PORT?.trim() || "3000");
  const host = readHostFromEnv(env);
  const runtimeLogDir = env.RUNTIME_LOG_DIR?.trim() || "./logs";

  const isProduction = env.NODE_ENV?.trim() === "production";
  const apiKey = env.RUNTIME_API_KEY?.trim() || undefined;
  const debugEnabled = env.RUNTIME_DEBUG_RESPONSE?.trim() === "true";
  const telegramConfig = readTelegramConfig(env, isProduction);
  const whatsappConfig = readWhatsAppConfig(env, isProduction);

  const app = buildRuntimeApp({
    openaiClient,
    openaiApiKey,
    model: runtimeEnv.runtimeModel,
    embeddingModel: runtimeEnv.runtimeEmbeddingModel,
    rpc,
    embeddingClient,
    runtimeTurnLogger: createFileRuntimeTurnLogger({ logDir: runtimeLogDir }),
    apiKey,
    isProduction,
    debugEnabled,
    telegram: telegramConfig,
    whatsapp: whatsappConfig,
  });

  const outboxEnabled = env.STAFF_NOTIFICATION_OUTBOX_ENABLED?.trim() !== "false";
  if (outboxEnabled) {
    const notifier = createAdminNotifier({
      config: loadAdminNotifyConfig(env as Record<string, string | undefined>),
      botToken: telegramConfig?.botToken ?? null,
    });
    const worker = createStaffNotificationOutboxWorker({
      repository: createSupabaseStaffNotificationOutboxRepository({ rpc }),
      notifier,
      batchSize: positiveInt(env.STAFF_NOTIFICATION_OUTBOX_BATCH_SIZE, 10, 1, 50),
      maxAttempts: positiveInt(env.STAFF_NOTIFICATION_OUTBOX_MAX_ATTEMPTS, 8, 1, 20),
      onEvent(event) {
        process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
      },
    });
    const loop = createStaffNotificationOutboxLoop({
      worker,
      pollMs: positiveInt(env.STAFF_NOTIFICATION_OUTBOX_POLL_MS, 5_000, 1_000, 300_000),
      onError(error) {
        process.stderr.write(`${JSON.stringify({
          ts: new Date().toISOString(),
          event: "staff_notification_outbox_loop_error",
          error_code: error instanceof Error ? error.name : "unknown",
        })}\n`);
      },
    });
    app.addHook("onReady", async () => { loop.start(); });
    app.addHook("onClose", async () => { loop.stop(); });
  }

  await app.listen({ port, host });
}

export function readHostFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUNTIME_HOST?.trim() || "0.0.0.0";
}

export function readTelegramConfig(
  env: NodeJS.ProcessEnv,
  isProduction: boolean,
): import("./runtime/runtimeServerBootstrap.ts").TelegramBootstrapConfig | undefined {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    if (isProduction && env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
      throw new Error("TELEGRAM_WEBHOOK_SECRET is set but TELEGRAM_BOT_TOKEN is missing");
    }
    return undefined;
  }
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
  if (isProduction && !webhookSecret) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required in production when TELEGRAM_BOT_TOKEN is set");
  }
  return {
    botToken,
    webhookSecret,
    defaultClinicCode: env.TELEGRAM_DEFAULT_CLINIC_CODE?.trim() || "clinic_1",
  };
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  startRuntimeServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

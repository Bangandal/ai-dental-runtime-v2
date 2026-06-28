import Fastify, { type FastifyInstance } from "fastify";
import OpenAI from "openai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readRuntimeServerEnv } from "./index.ts";
import { registerRuntimeRoutes } from "./runtime/runtimeServerBootstrap.ts";
import type { RpcCaller } from "./runtime/runtimeRepositories.ts";
import type { EmbeddingClient } from "./runtime/supabaseKnowledgeRepository.ts";
import { createFileRuntimeTurnLogger, createNoopRuntimeTurnLogger, type RuntimeTurnLogger } from "./runtime/runtimeTurnLogger.ts";

export interface BuildRuntimeAppDeps {
  openaiClient: OpenAI;
  rpc: RpcCaller;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  model: string;
  runtimeTurnLogger?: RuntimeTurnLogger;
  apiKey?: string | undefined;
  isProduction?: boolean;
  debugEnabled?: boolean;
  telegram?: import("./runtime/runtimeServerBootstrap.ts").TelegramBootstrapConfig;
}

export function buildRuntimeApp(deps: BuildRuntimeAppDeps): FastifyInstance {
  const app = Fastify();

  app.get("/health", async () => ({ ok: true }));

  registerRuntimeRoutes(app, {
    openaiClient: deps.openaiClient,
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

export async function startRuntimeServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const openaiApiKey = readRequiredEnv("OPENAI_API_KEY", env);
  const openaiClient = new OpenAI({ apiKey: openaiApiKey });
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

  const app = buildRuntimeApp({
    openaiClient,
    model: runtimeEnv.runtimeModel,
    embeddingModel: runtimeEnv.runtimeEmbeddingModel,
    rpc,
    embeddingClient,
    runtimeTurnLogger: createFileRuntimeTurnLogger({ logDir: runtimeLogDir }),
    apiKey,
    isProduction,
    debugEnabled,
    telegram: telegramConfig,
  });

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

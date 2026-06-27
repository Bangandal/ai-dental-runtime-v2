import { registerRuntimeRoutes, type RuntimeServerBootstrapDeps } from "./runtime/runtimeServerBootstrap.ts";
import type { RouteRegistrationApp } from "./runtime/runtimeTurnHttpRoute.ts";

export interface RuntimeServerEnv {
  runtimeModel: string;
  runtimeEmbeddingModel: string;
}

export function readRuntimeServerEnv(env: NodeJS.ProcessEnv = process.env): RuntimeServerEnv {
  return {
    runtimeModel: env.RUNTIME_OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    runtimeEmbeddingModel: env.RUNTIME_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
  };
}

export interface RuntimeServerDeps {
  app: RouteRegistrationApp;
  openaiClient: RuntimeServerBootstrapDeps["openaiClient"];
  rpc: RuntimeServerBootstrapDeps["rpc"];
  embeddingClient: RuntimeServerBootstrapDeps["embeddingClient"];
  env?: RuntimeServerEnv;
  apiKey?: string | undefined;
  isProduction?: boolean;
  debugEnabled?: boolean;
}

export function bootstrapRuntimeServer(deps: RuntimeServerDeps): RouteRegistrationApp {
  const runtimeEnv = deps.env ?? readRuntimeServerEnv();
  registerRuntimeRoutes(deps.app, {
    openaiClient: deps.openaiClient,
    model: runtimeEnv.runtimeModel,
    embeddingModel: runtimeEnv.runtimeEmbeddingModel,
    rpc: deps.rpc,
    embeddingClient: deps.embeddingClient,
    apiKey: deps.apiKey,
    isProduction: deps.isProduction,
    debugEnabled: deps.debugEnabled,
  });
  return deps.app;
}

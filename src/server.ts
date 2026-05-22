import { registerRuntimeRoutes, type RuntimeServerBootstrapDeps } from "./runtime/runtimeServerBootstrap.ts";
import type { RouteRegistrationApp } from "./runtime/runtimeTurnHttpRoute.ts";

export interface RuntimeServerEnv {
  runtimeModel: string;
}

export function readRuntimeServerEnv(env: NodeJS.ProcessEnv = process.env): RuntimeServerEnv {
  return {
    runtimeModel: env.RUNTIME_OPENAI_MODEL?.trim() || "gpt-4.1-mini",
  };
}

export interface RuntimeServerDeps {
  app: RouteRegistrationApp;
  openaiClient: RuntimeServerBootstrapDeps["openaiClient"];
  rpc: RuntimeServerBootstrapDeps["rpc"];
  env?: RuntimeServerEnv;
}

export function bootstrapRuntimeServer(deps: RuntimeServerDeps): RouteRegistrationApp {
  const runtimeEnv = deps.env ?? readRuntimeServerEnv();
  registerRuntimeRoutes(deps.app, {
    openaiClient: deps.openaiClient,
    model: runtimeEnv.runtimeModel,
    rpc: deps.rpc,
  });
  return deps.app;
}

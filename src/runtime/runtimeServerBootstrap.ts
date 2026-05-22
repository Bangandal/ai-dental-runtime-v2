import { registerRuntimeTurnRoute, type RouteRegistrationApp } from "./runtimeTurnHttpRoute.ts";
import { createDentalRuntimeTurnService } from "./runtimeTurnService.ts";
import type { OpenAIResponsesClient } from "./openaiRuntimeAgentCaller.ts";
import type { RpcCaller } from "./runtimeRepositories.ts";

export interface RuntimeServerBootstrapDeps {
  openaiClient: OpenAIResponsesClient;
  model: string;
  rpc: RpcCaller;
}

export function registerRuntimeRoutes(app: RouteRegistrationApp, deps: RuntimeServerBootstrapDeps): void {
  registerRuntimeTurnRoute(app, {
    runtimeTurnService: createDentalRuntimeTurnService({
      openaiClient: deps.openaiClient,
      model: deps.model,
      rpc: deps.rpc,
    }),
  });
}

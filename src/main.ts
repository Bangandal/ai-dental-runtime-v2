import Fastify, { type FastifyInstance } from "fastify";
import OpenAI from "openai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readRuntimeServerEnv } from "./index.ts";
import { registerRuntimeRoutes } from "./runtime/runtimeServerBootstrap.ts";
import type { RpcCaller } from "./runtime/runtimeRepositories.ts";

export interface BuildRuntimeAppDeps {
  openaiClient: OpenAI;
  rpc: RpcCaller;
  model: string;
}

export function buildRuntimeApp(deps: BuildRuntimeAppDeps): FastifyInstance {
  const app = Fastify();

  app.get("/health", async () => ({ ok: true }));

  registerRuntimeRoutes(app, {
    openaiClient: deps.openaiClient,
    model: deps.model,
    rpc: deps.rpc,
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
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey);

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
  const port = Number(env.PORT?.trim() || "3000");

  const app = buildRuntimeApp({
    openaiClient,
    model: runtimeEnv.runtimeModel,
    rpc,
  });

  await app.listen({ port, host: "0.0.0.0" });
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  startRuntimeServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

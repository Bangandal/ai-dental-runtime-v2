import { checkRuntimeApiKey, extractBearerToken } from "./runtimeApiAuth.ts";
import type { RateLimiter } from "./runtimeRateLimiter.ts";
import type { RuntimeTurnService } from "./runtimeTurnService.ts";
import type { RuntimeTurnLogger } from "./runtimeTurnLogger.ts";
import type { OpenAIConversationMemoryRepository } from "./supabaseOpenAIConversationMemoryRepository.ts";
import type { TurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";
import type { ClinicIdentityResolver } from "./supabaseClinicIdentityResolver.ts";
import type { RuntimeContextRepository } from "./supabaseRuntimeContextRepository.ts";
import type { CaseContextRepository } from "./supabaseCaseContextRepository.ts";
import type { CaseRouterClassifier } from "./caseRouterShadow.ts";
import type { RuntimeGateClassifier } from "./runtimeGateShadow.ts";
import type { TurnUnderstandingClassifier } from "./turnUnderstandingShadow.ts";
import { runRuntimeTurnOrchestrated } from "./runtimeTurnOrchestrator.ts";

export interface RuntimeTurnHttpRequestBody {
  clinic_code?: string;
  channel?: string;
  external_user_id?: string;
  chat_id?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

export interface RuntimeTurnHttpSuccessResponse {
  trace_id: string;
  reply_text: string;
  final_patient_reply: string;
  conversation_id?: string | null;
  tool_results?: unknown[];
  side_effects: unknown[];
  debug?: unknown;
}

export interface RuntimeTurnHttpErrorResponse {
  error: {
    code: "invalid_runtime_turn_request";
    message: string;
  };
}

export interface RuntimeTurnRouteDeps {
  runtimeTurnService: RuntimeTurnService;
  runtimeTurnLogger: RuntimeTurnLogger;
  openAIConversationMemoryRepository?: OpenAIConversationMemoryRepository;
  createOpenAIConversation?: () => Promise<string | null>;
  turnPersistenceRepository?: TurnPersistenceRepository;
  clinicIdentityResolver?: ClinicIdentityResolver;
  runtimeContextRepository?: RuntimeContextRepository;
  caseContextRepository?: CaseContextRepository;
  caseRouterClassifier?: CaseRouterClassifier;
  runtimeGateClassifier?: RuntimeGateClassifier;
  turnUnderstandingClassifier?: TurnUnderstandingClassifier;
  apiKey?: string | undefined;
  isProduction?: boolean;
  rateLimiter?: RateLimiter;
  debugEnabled?: boolean;
}

export interface RouteRequest {
  body: RuntimeTurnHttpRequestBody;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

export interface RouteRegistrationApp {
  post(
    path: string,
    handler: (request: RouteRequest, reply: RouteReply) => Promise<void>,
  ): void;
}

export interface RouteReply {
  code(statusCode: number): RouteReply;
  send(payload: RuntimeTurnHttpSuccessResponse | RuntimeTurnHttpErrorResponse | { error: { code: string; message: string } } | { ok: boolean }): void;
}

export function registerRuntimeTurnRoute(app: RouteRegistrationApp, deps: RuntimeTurnRouteDeps): void {
  app.post("/runtime/turn", async (request, reply) => {
    // Auth — before any business logic.
    const authResult = checkRuntimeApiKey({
      configuredKey: deps.apiKey,
      authHeader: asHeaderString(request.headers["authorization"]),
      apiKeyHeader: asHeaderString(request.headers["x-runtime-api-key"]),
      isProduction: deps.isProduction ?? false,
    });
    if (!authResult.ok) {
      reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized" } });
      return;
    }

    // Rate limit — key is API key when present, else IP.
    if (deps.rateLimiter) {
      const rateLimitKey =
        extractBearerToken(asHeaderString(request.headers["authorization"])) ??
        asHeaderString(request.headers["x-runtime-api-key"]) ??
        request.ip ??
        "unknown";
      if (!deps.rateLimiter.check(rateLimitKey)) {
        reply.code(429).send({ error: { code: "rate_limit_exceeded", message: "Too many requests" } });
        return;
      }
    }

    const result = await runRuntimeTurnOrchestrated(request.body, deps);
    switch (result.outcome) {
      case "success":
        reply.send(result.payload);
        return;
      case "duplicate":
        reply.code(200).send({ ok: true });
        return;
      case "invalid_request":
        reply.code(400).send({ error: { code: "invalid_runtime_turn_request", message: result.message } });
        return;
      case "clinic_not_found":
        reply.code(400).send({ error: { code: "invalid_runtime_turn_request", message: "unknown clinic" } });
        return;
      case "error":
        reply.send(result.fallbackPayload);
        return;
    }
  });
}

function asHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

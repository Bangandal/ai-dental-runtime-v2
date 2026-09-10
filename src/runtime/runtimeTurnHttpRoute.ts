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
import type { AdminNotifier } from "../integrations/adminNotify/adminNotifyTypes.ts";
import type { StaffRequestRepository } from "./staffRequest.ts";
import type { CaseLiteExtractor } from "./openaiRuntimeCaseLiteExtractor.ts";
import type { ChannelContact } from "./openaiRuntimeAgent.ts";
import { readVoiceTrustedContactToken } from "./voiceTrustedContactToken.ts";

export interface RuntimeTurnHttpRequestBody {
  clinic_code?: string;
  channel?: string;
  external_user_id?: string;
  chat_id?: string;
  text?: string;
  meta?: Record<string, unknown>;
  /** Opaque transport proof. It is stripped before orchestration/persistence/model context. */
  voice_contact_token?: string;
}

export interface RuntimeTurnHttpSuccessResponse {
  trace_id: string;
  reply_text: string;
  final_patient_reply: string;
  conversation_id?: string | null;
  tool_results?: unknown[];
  side_effects: unknown[];
  debug?: unknown;
  ui?: { telegram?: { request_contact?: boolean; button_text?: string } };
}

export interface RuntimeTurnHttpErrorResponse {
  error: { code: "invalid_runtime_turn_request"; message: string };
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
  adminNotifier?: AdminNotifier;
  staffRequestRepository?: StaffRequestRepository;
  caseLiteExtractor?: CaseLiteExtractor;
}

export interface RouteRequest {
  body: RuntimeTurnHttpRequestBody;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

export interface RouteRegistrationApp {
  post(path: string, handler: (request: RouteRequest, reply: RouteReply) => Promise<void>): void;
}

export interface RouteReply {
  code(statusCode: number): RouteReply;
  send(payload: RuntimeTurnHttpSuccessResponse | RuntimeTurnHttpErrorResponse | { error: { code: string; message: string } } | { ok: boolean }): void;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractTrustedVoiceChannelContact(
  body: RuntimeTurnHttpRequestBody,
  runtimeApiKey: string | undefined,
): ChannelContact | undefined {
  if (readString(body.channel) !== "voice" || !runtimeApiKey?.trim() || !body.voice_contact_token) return undefined;

  const clinicCode = readString(body.clinic_code);
  const conversationId = readString(body.meta?.voice_conversation_id);
  const callSid = readString(body.meta?.twilio_call_sid);
  const messageId = readString(body.meta?.message_id);
  if (!clinicCode || !conversationId || !callSid || !messageId) return undefined;

  const phoneNumber = readVoiceTrustedContactToken({
    runtimeApiKey,
    token: body.voice_contact_token,
    context: { clinicCode, conversationId, callSid, messageId },
  });
  if (!phoneNumber) return undefined;

  // The source literal is already enforced by the transport boundary and the booking
  // authority's TRUSTED_PHONE_SOURCES. Keep this cast local until ChannelContact's
  // historical union is widened without touching the model-visible contract.
  return {
    phone_number: phoneNumber,
    phone_source: "voice_sip_caller",
    phone_collected_at: new Date().toISOString(),
  } as unknown as ChannelContact;
}

export function registerRuntimeTurnRoute(app: RouteRegistrationApp, deps: RuntimeTurnRouteDeps): void {
  app.post("/runtime/turn", async (request, reply) => {
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

    const trustedChannelContact = extractTrustedVoiceChannelContact(request.body, deps.apiKey);
    const { voice_contact_token: _voiceContactToken, ...runtimeBody } = request.body;
    const result = await runRuntimeTurnOrchestrated(
      runtimeBody,
      deps,
      trustedChannelContact ? { trustedChannelContact } : undefined,
    );
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

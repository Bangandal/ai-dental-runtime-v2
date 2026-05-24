import { randomUUID } from "node:crypto";

import type { RuntimeTurnInput, RuntimeTurnService } from "./runtimeTurnService.ts";
import type { RuntimeTurnLogger } from "./runtimeTurnLogger.ts";
import type { OpenAIConversationMemoryRepository } from "./supabaseOpenAIConversationMemoryRepository.ts";
import type { TurnPersistenceRepository } from "./supabaseTurnPersistenceRepository.ts";

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
}

export interface RouteRegistrationApp {
  post(
    path: string,
    handler: (request: { body: RuntimeTurnHttpRequestBody }, reply: RouteReply) => Promise<void>,
  ): void;
}

export interface RouteReply {
  code(statusCode: number): RouteReply;
  send(payload: RuntimeTurnHttpSuccessResponse | RuntimeTurnHttpErrorResponse): void;
}

const RUNTIME_FALLBACK_REPLY =
  "Извините, сейчас не удалось обработать сообщение. Администратор проверит вручную.";
const UUID_V4_OR_V1_TO_V5_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerRuntimeTurnRoute(app: RouteRegistrationApp, deps: RuntimeTurnRouteDeps): void {
  app.post("/runtime/turn", async (request, reply) => {
    const startTime = Date.now();
    const validationError = validateRuntimeTurnRequest(request.body);
    if (validationError) {
      void deps.runtimeTurnLogger.logError({
        ts: new Date().toISOString(),
        status: "validation_error",
        trace_id: null,
        error_code: "invalid_runtime_turn_request",
        error_message: validationError,
        channel: readSafeField(request.body?.channel),
        external_user_id: readSafeField(request.body?.external_user_id),
        chat_id: readSafeField(request.body?.chat_id),
        input_text: readSafeField(request.body?.text),
        latency_ms: Date.now() - startTime,
      }).catch(() => undefined);
      reply.code(400).send({
        error: {
          code: "invalid_runtime_turn_request",
          message: validationError,
        },
      });
      return;
    }

    const body = request.body as Required<Pick<RuntimeTurnHttpRequestBody, "clinic_code" | "channel" | "text">> &
      RuntimeTurnHttpRequestBody;
    const traceId = randomUUID();
    const externalUserId = body.external_user_id?.trim() || undefined;
    const chatId = body.chat_id?.trim() || undefined;

    const persistenceDebug: Record<string, unknown> = {};

    const runtimeTurnInput: RuntimeTurnInput = {
      trace_id: traceId,
      clinic_id: body.clinic_code.trim(),
      contact_id: `${body.channel.trim()}:${externalUserId ?? chatId}`,
      case_id: null,
      user_message: body.text.trim(),
      locale: readLocale(body.meta),
      business_context: {
        channel: body.channel.trim(),
        chat_id: chatId,
        external_user_id: externalUserId,
        meta: body.meta,
      },
      recent_summary: null,
    };


    if (deps.turnPersistenceRepository) {
      const contactResult = await deps.turnPersistenceRepository.getOrCreateContact({
        clinic_id: body.clinic_code.trim(),
        channel: body.channel.trim(),
        external_user_id: externalUserId ?? null,
        chat_id: chatId ?? null,
        username: typeof body.meta?.username === "string" ? body.meta.username : null,
        first_name: typeof body.meta?.first_name === "string" ? body.meta.first_name : null,
        last_name: typeof body.meta?.last_name === "string" ? body.meta.last_name : null,
      }).catch((error) => ({ ok: false, error: { code: "contact_persist_exception", message: error instanceof Error ? error.message : String(error), retryable: true } } as const));
      persistenceDebug.contact = contactResult.ok ? "ok" : "error";
      if (contactResult.ok) {
        runtimeTurnInput.contact_id = contactResult.data.contact_id;
      }
      const contactIdForPre = runtimeTurnInput.contact_id;
      const inboundResult = await deps.turnPersistenceRepository.registerInboundEvent({
        clinic_id: runtimeTurnInput.clinic_id, contact_id: contactIdForPre, channel: runtimeTurnInput.business_context.channel, external_user_id: externalUserId ?? null, chat_id: chatId ?? null, trace_id: traceId, raw_payload: body.meta ?? null,
      }).catch(() => ({ ok: false } as const));
      persistenceDebug.inbound_event = inboundResult.ok ? "ok" : "error";
      const userMsgResult = await deps.turnPersistenceRepository.saveMessage({
        clinic_id: runtimeTurnInput.clinic_id, contact_id: contactIdForPre, role: "user", text: runtimeTurnInput.user_message, trace_id: traceId,
      }).catch(() => ({ ok: false } as const));
      persistenceDebug.save_user_message = userMsgResult.ok ? "ok" : "error";
    }

    const memoryDebug: Record<string, unknown> = {};

    if (deps.openAIConversationMemoryRepository) {
      try {
        const loadedMemory = await deps.openAIConversationMemoryRepository.getConversationMemory({
          clinic_id: body.clinic_code.trim(),
          channel: body.channel.trim(),
          external_user_id: externalUserId ?? null,
          chat_id: chatId ?? null,
        });
        memoryDebug.memory_lookup = {
          ok: loadedMemory.ok,
          clinic_id: body.clinic_code.trim(),
          channel: body.channel.trim(),
          external_user_id: externalUserId ?? null,
          chat_id: chatId ?? null,
          conversation_id: loadedMemory.ok ? loadedMemory.data.conversation_id : null,
          error: loadedMemory.ok ? null : loadedMemory.error,
        };
        if (loadedMemory.ok && loadedMemory.data.conversation_id) {
          runtimeTurnInput.conversation_id = loadedMemory.data.conversation_id;
        }
      } catch (error) {
        memoryDebug.memory_lookup = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (!runtimeTurnInput.conversation_id && deps.createOpenAIConversation) {
      try {
        const createdConversationId = await deps.createOpenAIConversation();
        if (createdConversationId) {
          runtimeTurnInput.conversation_id = createdConversationId;
        }
      } catch {
        // non-fatal by contract
      }
    }

    try {
      const result = await deps.runtimeTurnService.runTurn(runtimeTurnInput);
      const conversationIdToPersist = result.conversation_id ?? runtimeTurnInput.conversation_id ?? null;
      if (conversationIdToPersist && deps.openAIConversationMemoryRepository) {
        try {
          const memorySaveResult = await deps.openAIConversationMemoryRepository.saveConversationMemory({
            clinic_id: runtimeTurnInput.clinic_id,
            channel: runtimeTurnInput.business_context.channel,
            external_user_id: runtimeTurnInput.business_context.external_user_id ?? null,
            chat_id: runtimeTurnInput.business_context.chat_id ?? null,
            conversation_id: conversationIdToPersist,
          });
          memoryDebug.memory_save = {
            ok: memorySaveResult.ok,
            conversation_id: conversationIdToPersist,
            error: memorySaveResult.ok ? null : memorySaveResult.error,
          };
        } catch (error) {
          memoryDebug.memory_save = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (deps.turnPersistenceRepository) {
        const assistantSave = await deps.turnPersistenceRepository.saveMessage({
          clinic_id: runtimeTurnInput.clinic_id, contact_id: runtimeTurnInput.contact_id, role: "assistant", text: result.final_patient_reply, trace_id: traceId,
        }).catch(() => ({ ok: false } as const));
        persistenceDebug.save_assistant_message = assistantSave.ok ? "ok" : "error";
        const assistantHasQuestion = /\?/.test(result.final_patient_reply);
        const mergeState = await deps.turnPersistenceRepository.mergeConversationState({
          clinic_id: runtimeTurnInput.clinic_id,
          contact_id: runtimeTurnInput.contact_id,
          patch: {
            last_user_message_text: runtimeTurnInput.user_message,
            last_assistant_message_text: result.final_patient_reply,
            last_intent: (result.debug as Record<string, unknown> | undefined)?.last_intent ?? null,
            last_bot_action: (result.debug as Record<string, unknown> | undefined)?.last_bot_action ?? null,
            last_bot_question: assistantHasQuestion ? result.final_patient_reply : null,
            conversation_id: conversationIdToPersist,
            openai_conversation_id: conversationIdToPersist,
            turn_count_increment: 1,
          },
        }).catch(() => ({ ok: false } as const));
        persistenceDebug.merge_state = mergeState.ok ? "ok" : "error";
      }

      const responsePayload: RuntimeTurnHttpSuccessResponse = {
        trace_id: traceId,
        reply_text: result.final_patient_reply,
        final_patient_reply: result.final_patient_reply,
        conversation_id: conversationIdToPersist,
        tool_results: result.tool_results,
        side_effects: [],
        debug: { ...(result.debug ?? {}), ...memoryDebug, persistence_debug: persistenceDebug },
      };
      void deps.runtimeTurnLogger.logTurn({
        ts: new Date().toISOString(),
        status: "ok",
        trace_id: traceId,
        clinic_id: runtimeTurnInput.clinic_id,
        contact_id: runtimeTurnInput.contact_id,
        case_id: runtimeTurnInput.case_id,
        conversation_id: conversationIdToPersist,
        channel: runtimeTurnInput.business_context.channel,
        external_user_id: runtimeTurnInput.business_context.external_user_id ?? null,
        chat_id: runtimeTurnInput.business_context.chat_id ?? null,
        input_text: runtimeTurnInput.user_message,
        final_patient_reply: result.final_patient_reply,
        tool_results: result.tool_results,
        side_effects: responsePayload.side_effects,
        debug: responsePayload.debug,
        latency_ms: Date.now() - startTime,
      }).catch(() => undefined);
      reply.send(responsePayload);
      return;
    } catch (error) {
      const runtimeError = error instanceof Error ? error.message : String(error);
      const fallbackPayload: RuntimeTurnHttpSuccessResponse = {
        trace_id: traceId,
        reply_text: RUNTIME_FALLBACK_REPLY,
        final_patient_reply: RUNTIME_FALLBACK_REPLY,
        side_effects: [
          {
            type: "admin_notification",
            channel: body.channel.trim(),
            reason: "runtime_turn_failed",
            payload: {
              trace_id: traceId,
              user_text: body.text.trim(),
              error_message: runtimeError,
            },
          },
        ],
        debug: {
          runtime_error: runtimeError,
        },
      };
      void deps.runtimeTurnLogger.logError({
        ts: new Date().toISOString(),
        status: "runtime_error",
        trace_id: traceId,
        error_code: "runtime_turn_failed",
        error_message: runtimeError,
        channel: runtimeTurnInput.business_context.channel,
        external_user_id: runtimeTurnInput.business_context.external_user_id ?? null,
        chat_id: runtimeTurnInput.business_context.chat_id ?? null,
        input_text: runtimeTurnInput.user_message,
        fallback_reply: fallbackPayload.final_patient_reply,
        side_effects: fallbackPayload.side_effects,
        latency_ms: Date.now() - startTime,
      }).catch(() => undefined);
      reply.send(fallbackPayload);
    }
  });
}

function validateRuntimeTurnRequest(body: RuntimeTurnHttpRequestBody | undefined): string | null {
  if (!body) {
    return "request body is required";
  }
  if (!body.clinic_code?.trim()) {
    return "clinic_code is required";
  }
  if (!UUID_V4_OR_V1_TO_V5_PATTERN.test(body.clinic_code.trim())) {
    return "clinic_code must be a valid UUID clinic_id";
  }
  if (!body.channel?.trim()) {
    return "channel is required";
  }
  if (!body.text?.trim()) {
    return "text is required";
  }
  if (!body.external_user_id?.trim() && !body.chat_id?.trim()) {
    return "external_user_id or chat_id is required";
  }
  return null;
}

function readLocale(meta: Record<string, unknown> | undefined): string | null {
  const languageCode = meta?.language_code;
  return typeof languageCode === "string" && languageCode.trim() ? languageCode.trim() : null;
}

function readSafeField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

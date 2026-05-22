import { randomUUID } from "node:crypto";

import type { RuntimeTurnInput, RuntimeTurnService } from "./runtimeTurnService.ts";

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

export function registerRuntimeTurnRoute(app: RouteRegistrationApp, deps: RuntimeTurnRouteDeps): void {
  app.post("/runtime/turn", async (request, reply) => {
    const validationError = validateRuntimeTurnRequest(request.body);
    if (validationError) {
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

    try {
      const result = await deps.runtimeTurnService.runTurn(runtimeTurnInput);
      reply.send({
        trace_id: traceId,
        reply_text: result.final_patient_reply,
        final_patient_reply: result.final_patient_reply,
        conversation_id: result.conversation_id ?? null,
        tool_results: result.tool_results,
        side_effects: [],
        debug: result.debug,
      });
      return;
    } catch (error) {
      const runtimeError = error instanceof Error ? error.message : String(error);
      reply.send({
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
      });
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

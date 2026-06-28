import { randomUUID } from "node:crypto";

import type { RuntimeTurnService } from "./runtimeTurnService.ts";
import type { ClinicIdentityResolver } from "./supabaseClinicIdentityResolver.ts";
import {
  checkTelegramWebhookSecret,
  normalizeTelegramUpdate,
  type TelegramUpdate,
} from "./telegramWebhookAdapter.ts";
import { sendTelegramMessage } from "./telegramSender.ts";

export interface TelegramWebhookRouteDeps {
  runtimeTurnService: RuntimeTurnService;
  clinicIdentityResolver?: ClinicIdentityResolver;
  botToken: string;
  webhookSecret: string | undefined;
  defaultClinicCode: string;
  isProduction: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface TelegramWebhookRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

export interface TelegramWebhookReply {
  code(n: number): TelegramWebhookReply;
  send(payload: unknown): void;
}

export interface TelegramRouteApp {
  post(
    path: string,
    handler: (request: TelegramWebhookRequest, reply: TelegramWebhookReply) => Promise<void>,
  ): void;
}

export function registerTelegramWebhookRoute(
  app: TelegramRouteApp,
  deps: TelegramWebhookRouteDeps,
): void {
  app.post("/webhooks/telegram", async (request, reply) => {
    const requestSecret = asHeaderString(
      request.headers["x-telegram-bot-api-secret-token"],
    );
    const secretResult = checkTelegramWebhookSecret({
      configuredSecret: deps.webhookSecret,
      requestSecret,
      isProduction: deps.isProduction,
    });
    if (!secretResult.ok) {
      reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized" } });
      return;
    }

    const update = request.body as TelegramUpdate;
    const normalized = normalizeTelegramUpdate(update, deps.defaultClinicCode);
    if (!normalized.ok) {
      reply.code(200).send({ ok: true });
      return;
    }

    const { body } = normalized;

    const clinicResult = await deps.clinicIdentityResolver?.resolveClinicIdentity({
      clinic_identifier: body.clinic_code,
    });
    if (!clinicResult?.ok) {
      reply.code(200).send({ ok: true });
      return;
    }

    const traceId = randomUUID();

    try {
      const result = await deps.runtimeTurnService.runTurn({
        trace_id: traceId,
        clinic_id: clinicResult.data.clinic_id,
        contact_id: null,
        case_id: null,
        user_message: body.text,
        locale: null,
        recent_summary: null,
        business_context: {
          channel: "telegram",
          chat_id: body.chat_id,
          external_user_id: body.external_user_id,
          transport_contact_key: `telegram:${body.external_user_id}`,
          meta: body.meta,
        },
      });

      void sendTelegramMessage({
        botToken: deps.botToken,
        chatId: body.chat_id,
        text: result.final_patient_reply,
        fetch: deps.fetch,
      });

      reply.code(200).send({ ok: true });
    } catch {
      reply.code(200).send({ ok: true });
    }
  });
}

function asHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

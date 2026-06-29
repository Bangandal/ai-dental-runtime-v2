import {
  checkTelegramWebhookSecret,
  normalizeTelegramUpdate,
  type TelegramUpdate,
} from "./telegramWebhookAdapter.ts";
import { sendTelegramMessage, buildContactRequestReplyMarkup } from "./telegramSender.ts";
import { runRuntimeTurnOrchestrated, type RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestrator.ts";

export interface TelegramWebhookRouteDeps extends RuntimeTurnOrchestratorDeps {
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
      // Unsupported update type — ack without calling LLM.
      reply.code(200).send({ ok: true });
      return;
    }

    // Contact update: patient shared phone via Telegram contact button.
    // Phone capture is normalized and available in normalized.capture.
    // Persistence gap: contact capture is not yet wired to the booking pipeline
    // (booking.apply is not implemented). See docs/TELEGRAM_CONTACT_CAPTURE.md.
    if (normalized.type === "contact") {
      reply.code(200).send({ ok: true });
      return;
    }

    // Text update — standard pipeline.
    const result = await runRuntimeTurnOrchestrated(normalized.body, deps);

    if (result.outcome === "duplicate") {
      // Already processed this update_id — return 200 without sending another message.
      reply.code(200).send({ ok: true });
      return;
    }

    if (result.outcome === "success" || result.outcome === "error") {
      const replyText =
        result.outcome === "success"
          ? result.payload.final_patient_reply
          : result.fallbackPayload.final_patient_reply;

      // If the runtime response requests a Telegram contact button, send reply_markup.
      const uiTelegram = result.outcome === "success" ? result.payload.ui?.telegram : undefined;
      const replyMarkup = uiTelegram?.request_contact === true
        ? buildContactRequestReplyMarkup(uiTelegram.button_text)
        : undefined;

      void sendTelegramMessage({
        botToken: deps.botToken,
        chatId: normalized.body.chat_id,
        text: replyText,
        replyMarkup,
        fetch: deps.fetch,
      });
    }

    // Always return 200 to Telegram to prevent retry loops.
    reply.code(200).send({ ok: true });
  });
}

function asHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

import {
  checkTelegramWebhookSecret,
  normalizeTelegramUpdate,
  type TelegramUpdate,
  type TelegramNormalizeResult,
} from "./telegramWebhookAdapter.ts";
import { sendTelegramMessage, sendTelegramMessageWithRetry, buildContactRequestReplyMarkup, buildRemoveKeyboardMarkup, type TelegramDeliveryOutcome } from "./telegramSender.ts";
import { runRuntimeTurnOrchestrated, type RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestrator.ts";

export interface TelegramWebhookRouteDeps extends RuntimeTurnOrchestratorDeps {
  botToken: string;
  webhookSecret: string | undefined;
  defaultClinicCode: string;
  isProduction: boolean;
  fetch?: typeof globalThis.fetch;
  onTelegramDelivery?: (outcome: TelegramDeliveryOutcome & { trace_id: string }) => void;
  telegramRetryBackoffMs?: number;
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

    // Contact update: patient shared someone else's contact — ownership mismatch.
    if (normalized.type === "contact_foreign") {
      void sendTelegramMessage({
        botToken: deps.botToken,
        chatId: normalized.chat_id,
        text: "Пожалуйста, поделитесь своим номером через кнопку «Поделиться контактом».",
        fetch: deps.fetch,
      });
      reply.code(200).send({ ok: true });
      return;
    }

    // Contact update: patient shared their own phone via Telegram contact button.
    if (normalized.type === "contact") {
      const persistResult = await persistChannelContactPhone(normalized, deps).catch(() => "state_persist_failed" as const);
      const replyText = persistResult === "persisted"
        ? "Спасибо, номер получен. Можем продолжить запись."
        : "Не получилось сохранить номер. Попробуйте поделиться контактом ещё раз или свяжитесь с клиникой напрямую.";
      void sendTelegramMessage({
        botToken: deps.botToken,
        chatId: normalized.chat_id,
        text: replyText,
        // Dismiss the contact keyboard after phone is successfully captured.
        replyMarkup: persistResult === "persisted" ? buildRemoveKeyboardMarkup() : undefined,
        fetch: deps.fetch,
      });
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
      const traceId =
        result.outcome === "success"
          ? result.payload.trace_id
          : result.fallbackPayload.trace_id;

      // If the runtime response requests a Telegram contact button, send reply_markup.
      const uiTelegram = result.outcome === "success" ? result.payload.ui?.telegram : undefined;
      const replyMarkup = uiTelegram?.request_contact === true
        ? buildContactRequestReplyMarkup(uiTelegram.button_text)
        : undefined;

      const delivery = await sendTelegramMessageWithRetry({
        botToken: deps.botToken,
        chatId: normalized.body.chat_id,
        text: replyText,
        replyMarkup,
        fetch: deps.fetch,
        retryBackoffMs: deps.telegramRetryBackoffMs,
      });

      try {
        deps.onTelegramDelivery?.({ ...delivery, trace_id: traceId });
      } catch {
        // swallow observability failure — must not affect webhook response
      }
    }

    // Always return 200 to Telegram to prevent retry loops.
    reply.code(200).send({ ok: true });
  });
}

export type ContactPhonePersistResult =
  | "persisted"
  | "not_configured"
  | "clinic_not_found"
  | "contact_persist_failed"
  | "state_persist_failed";

export async function persistChannelContactPhone(
  normalized: Extract<TelegramNormalizeResult, { type: "contact" }>,
  deps: Pick<TelegramWebhookRouteDeps, "clinicIdentityResolver" | "turnPersistenceRepository">,
): Promise<ContactPhonePersistResult> {
  if (!deps.clinicIdentityResolver || !deps.turnPersistenceRepository) {
    return "not_configured";
  }

  const clinicResult = await deps.clinicIdentityResolver.resolveClinicIdentity({
    clinic_identifier: normalized.clinic_code,
  }).catch(() => null);
  if (!clinicResult || !clinicResult.ok) {
    return "clinic_not_found";
  }

  const contactResult = await deps.turnPersistenceRepository.getOrCreateContact({
    clinic_code: normalized.clinic_code,
    channel: "telegram",
    external_user_id: normalized.external_user_id,
    chat_id: normalized.chat_id,
  }).catch(() => null);
  if (!contactResult || !contactResult.ok) {
    return "contact_persist_failed";
  }

  const stateResult = await deps.turnPersistenceRepository.mergeConversationState({
    clinic_id: clinicResult.data.clinic_id,
    contact_id: contactResult.data.contact_id,
    user_text: "[contact_shared]",
    reply_text: "Спасибо, номер получен. Можем продолжить запись.",
    requested_action: "phone_captured",
    conversation_intent: "booking",
    handoff_recommended: false,
    confidence: "high",
    // Stored in control_flags JSONB merged into conversation state by rpc_merge_conversation_state.
    // rpc_get_runtime_context returns the merged blob as out_state_json, so channel_contact
    // survives the round trip as stateJson.channel_contact — same contract as topic_memory.
    control_flags: {
      channel_contact: {
        phone_number: normalized.capture.phone_number,
        phone_source: normalized.capture.phone_source,
        phone_consent: normalized.capture.phone_consent,
        phone_collected_at: normalized.capture.phone_collected_at,
        telegram_contact_user_id: normalized.capture.telegram_contact.user_id ?? null,
      },
    },
  }).catch(() => null);
  if (!stateResult || !stateResult.ok) {
    return "state_persist_failed";
  }

  return "persisted";
}

function asHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

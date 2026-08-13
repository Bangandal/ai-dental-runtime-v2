import {
  checkTelegramWebhookSecret,
  normalizeTelegramUpdate,
  type TelegramUpdate,
  type TelegramNormalizeResult,
} from "./telegramWebhookAdapter.ts";
import { sendTelegramMessage, sendTelegramMessageWithRetry, buildContactRequestReplyMarkup, buildRemoveKeyboardMarkup, type TelegramDeliveryOutcome } from "./telegramSender.ts";
import { runRuntimeTurnOrchestrated, type RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestrator.ts";
import { resolveTelegramMedia } from "./telegramMediaResolver.ts";
import { transcribeAudio } from "./audioTranscription.ts";

export interface TelegramWebhookRouteDeps extends RuntimeTurnOrchestratorDeps {
  botToken: string;
  webhookSecret: string | undefined;
  defaultClinicCode: string;
  isProduction: boolean;
  fetch?: typeof globalThis.fetch;
  onTelegramDelivery?: (outcome: TelegramDeliveryOutcome & { trace_id: string }) => void;
  telegramRetryBackoffMs?: number;
  openaiApiKey?: string;
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
      if (persistResult !== "persisted") {
        void sendTelegramMessage({
          botToken: deps.botToken,
          chatId: normalized.chat_id,
          text: "Не получилось сохранить номер. Попробуйте поделиться контактом ещё раз или свяжитесь с клиникой напрямую.",
          fetch: deps.fetch,
        });
        reply.code(200).send({ ok: true });
        return;
      }

      // Phone persisted — run through the runtime so the OpenAI conversation thread is
      // updated. Without this, the next user turn would see stale thread history ("waiting
      // for phone") and the model would incorrectly repeat the phone request instead of
      // asking for the missing name.
      const contactTurnResult = await runRuntimeTurnOrchestrated(
        {
          clinic_code: normalized.clinic_code,
          channel: "telegram",
          external_user_id: normalized.external_user_id,
          chat_id: normalized.chat_id,
          text: "[contact_shared]",
          meta: {
            update_id: normalized.update_id,
            message_id: normalized.message_id,
            username: null,
            first_name: null,
            last_name: null,
            telegram_chat_type: "private",
          },
        },
        deps,
      );

      let contactReplyText: string;
      let contactTraceId: string | undefined;
      if (contactTurnResult.outcome === "success") {
        contactReplyText = contactTurnResult.payload.final_patient_reply;
        contactTraceId = contactTurnResult.payload.trace_id ?? undefined;
      } else if (contactTurnResult.outcome === "error") {
        contactReplyText = contactTurnResult.fallbackPayload.final_patient_reply;
        contactTraceId = contactTurnResult.fallbackPayload.trace_id ?? undefined;
      } else {
        // duplicate / invalid_request / clinic_not_found — safe fallback
        contactReplyText = "Спасибо, номер получен. Можем продолжить запись.";
      }

      // Always dismiss the contact keyboard after phone capture, regardless of runtime UI.
      const contactDelivery = await sendTelegramMessageWithRetry({
        botToken: deps.botToken,
        chatId: normalized.chat_id,
        text: contactReplyText,
        replyMarkup: buildRemoveKeyboardMarkup(),
        fetch: deps.fetch,
        retryBackoffMs: deps.telegramRetryBackoffMs,
      });
      try {
        if (contactTraceId) deps.onTelegramDelivery?.({ ...contactDelivery, trace_id: contactTraceId });
      } catch {
        // swallow observability failure
      }
      reply.code(200).send({ ok: true });
      return;
    }

    // Voice/audio message — transcribe then run as text turn.
    if (normalized.type === "voice") {
      const apiKey = deps.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "";
      const fetchFn = deps.fetch ?? globalThis.fetch;

      const mediaResult = await resolveTelegramMedia(
        normalized.file_id,
        deps.botToken,
        undefined,
        fetchFn,
      );
      if (!mediaResult.ok) {
        console.error(JSON.stringify({
          event: "telegram_voice_preprocessing_failure",
          channel: "telegram",
          stage: "media_download",
          error_code: mediaResult.error_code,
          mime_type: normalized.mime_type ?? "audio/ogg",
          byte_count: 0,
        }));
        void sendTelegramMessage({
          botToken: deps.botToken,
          chatId: normalized.chat_id,
          text: "Не удалось обработать голосовое сообщение. Попробуйте ещё раз или напишите текстом.",
          fetch: fetchFn,
        });
        reply.code(200).send({ ok: true });
        return;
      }

      // Prefer MIME declared by Telegram in the webhook over file_path-derived MIME.
      // Telegram getFile may return .oga paths; "audio/ogg" from the webhook is authoritative.
      const effectiveMimeType = normalized.mime_type || mediaResult.mime_type || "audio/ogg";

      const transcription = await transcribeAudio(
        {
          channel: "telegram",
          message_id: normalized.message_id,
          external_user_id: normalized.external_user_id,
          mime_type: effectiveMimeType,
          duration_seconds: normalized.duration_seconds,
          bytes: mediaResult.bytes!,
        },
        apiKey,
        undefined,
        fetchFn,
      );
      if (!transcription.ok || !transcription.text) {
        console.error(JSON.stringify({
          event: "telegram_voice_preprocessing_failure",
          channel: "telegram",
          stage: "transcription",
          error_code: transcription.error_code,
          mime_type: effectiveMimeType,
          byte_count: mediaResult.bytes!.length,
        }));
        void sendTelegramMessage({
          botToken: deps.botToken,
          chatId: normalized.chat_id,
          text: "Не удалось обработать голосовое сообщение. Попробуйте ещё раз или напишите текстом.",
          fetch: fetchFn,
        });
        reply.code(200).send({ ok: true });
        return;
      }

      const voiceTurnBody = {
        clinic_code: normalized.clinic_code,
        channel: "telegram" as const,
        external_user_id: normalized.external_user_id,
        chat_id: normalized.chat_id,
        text: transcription.text,
        meta: {
          ...normalized.meta,
          input_modality: "voice",
          original_mime_type: effectiveMimeType,
        },
      };

      const voiceResult = await runRuntimeTurnOrchestrated(voiceTurnBody, deps);

      if (voiceResult.outcome === "duplicate") {
        reply.code(200).send({ ok: true });
        return;
      }

      if (voiceResult.outcome === "success" || voiceResult.outcome === "error") {
        const replyText =
          voiceResult.outcome === "success"
            ? voiceResult.payload.final_patient_reply
            : voiceResult.fallbackPayload.final_patient_reply;
        const traceId =
          voiceResult.outcome === "success"
            ? voiceResult.payload.trace_id
            : voiceResult.fallbackPayload.trace_id;
        const uiTelegram = voiceResult.outcome === "success" ? voiceResult.payload.ui?.telegram : undefined;
        const replyMarkup = uiTelegram?.request_contact === true
          ? buildContactRequestReplyMarkup(uiTelegram.button_text)
          : undefined;
        const delivery = await sendTelegramMessageWithRetry({
          botToken: deps.botToken,
          chatId: normalized.chat_id,
          text: replyText,
          replyMarkup,
          fetch: fetchFn,
          retryBackoffMs: deps.telegramRetryBackoffMs,
        });
        try {
          deps.onTelegramDelivery?.({ ...delivery, trace_id: traceId });
        } catch {
          // swallow observability failure
        }
      }

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

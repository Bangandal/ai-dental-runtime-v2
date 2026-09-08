import { normalizeWhatsAppPayload, normalizeWhatsAppPhone, verifyWhatsAppSignature } from "./whatsappWebhookAdapter.ts";
import { sendWhatsAppMessage } from "./whatsappSender.ts";
import { runRuntimeTurnOrchestrated, type RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestrator.ts";
import { downloadWhatsAppMedia } from "./whatsappMediaDownloader.ts";
import { transcribeAudio } from "./audioTranscription.ts";
import { handleInboundMediaStaffRequest } from "./inboundMediaStaffRequest.ts";

export interface WhatsAppWebhookRouteDeps extends RuntimeTurnOrchestratorDeps {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string | null;
  graphApiVersion: string;
  clinicId: string;
  fetch?: typeof globalThis.fetch;
  openaiApiKey?: string;
}

export interface WhatsAppGetRequest {
  query: Record<string, string | string[] | undefined>;
}

export interface WhatsAppPostRequest {
  body: unknown;
  rawBody: Buffer | null;
  headers: Record<string, string | string[] | undefined>;
}

export interface WhatsAppWebhookReply {
  code(n: number): WhatsAppWebhookReply;
  send(payload: unknown): void;
}

export interface WhatsAppRouteApp {
  get(
    path: string,
    handler: (request: WhatsAppGetRequest, reply: WhatsAppWebhookReply) => Promise<void>,
  ): void;
  post(
    path: string,
    handler: (request: WhatsAppPostRequest, reply: WhatsAppWebhookReply) => Promise<void>,
  ): void;
}

export function registerWhatsAppWebhookRoute(
  app: WhatsAppRouteApp,
  deps: WhatsAppWebhookRouteDeps,
): void {
  // GET — Meta webhook verification handshake
  app.get("/webhooks/whatsapp", async (request, reply) => {
    const mode = asQueryString(request.query["hub.mode"]);
    const token = asQueryString(request.query["hub.verify_token"]);
    const challenge = asQueryString(request.query["hub.challenge"]);

    if (mode === "subscribe" && token === deps.verifyToken) {
      reply.code(200).send(challenge ?? "");
      return;
    }

    reply.code(403).send({ error: "Forbidden" });
  });

  // POST — incoming webhook events
  app.post("/webhooks/whatsapp", async (request, reply) => {
    if (deps.appSecret) {
      if (request.rawBody === null) {
        reply.code(400).send({ error: "Raw body unavailable for signature verification" });
        return;
      }
      const sigHeader = asHeaderString(request.headers["x-hub-signature-256"]);
      const sigResult = verifyWhatsAppSignature({
        rawBody: request.rawBody,
        signatureHeader: sigHeader,
        appSecret: deps.appSecret,
      });
      if (!sigResult.ok) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
    }

    const normalized = normalizeWhatsAppPayload(request.body, deps.clinicId);

    if (!normalized.ok) {
      reply.code(200).send({ ok: true });
      return;
    }

    // Process turns in original provider order. Photo/document notices are metadata-only;
    // only voice/audio is downloaded because transcription genuinely requires the bytes.
    for (const item of normalized.normalizedTurns ?? []) {
      if (item.type === "media_notice") {
        const mediaTurn = item.turn;
        const result = await handleInboundMediaStaffRequest({
          clinic_code: deps.clinicId,
          channel: "whatsapp",
          external_user_id: mediaTurn.waId,
          chat_id: mediaTurn.waId,
          message_id: mediaTurn.messageId,
          media_kind: mediaTurn.media_kind,
          phone_source: "whatsapp_sender",
          phone_available: true,
        }, deps).catch(() => ({ outcome: "failed" as const, reason: "media_staff_request_exception" }));
        if (result.outcome === "failed") {
          console.error(JSON.stringify({
            event: "whatsapp_media_staff_request_failure",
            channel: "whatsapp",
            reason: result.reason,
            message_type: mediaTurn.media_kind,
          }));
        }
        continue;
      }

      if (item.type === "text") {
        const turn = item.turn;
        const trustedChannelContact = {
          phone_number: normalizeWhatsAppPhone(turn.waId),
          phone_source: "whatsapp_sender" as const,
          phone_consent: false as const,
          phone_collected_at: new Date().toISOString(),
        };

        let traceId = "";
        const result = await runRuntimeTurnOrchestrated(turn.runtimeBody, deps, {
          trustedChannelContact,
          requireInboundRegistration: true,
        }).catch(
          (): { outcome: "error"; fallbackPayload: { final_patient_reply: string; trace_id: string } } => ({
            outcome: "error",
            fallbackPayload: { final_patient_reply: "", trace_id: "" },
          }),
        );

        if (result.outcome === "duplicate" || result.outcome === "inbound_registration_failed") {
          continue;
        }

        let replyText: string | null = null;

        if (result.outcome === "success") {
          replyText = result.payload.final_patient_reply || null;
          traceId = result.payload.trace_id;
        } else if (result.outcome === "error") {
          replyText = result.fallbackPayload.final_patient_reply || null;
          traceId = result.fallbackPayload.trace_id;
        }

        if (!replyText || !replyText.trim()) {
          continue;
        }

        const sendResult = await sendWhatsAppMessage({
          accessToken: deps.accessToken,
          phoneNumberId: deps.phoneNumberId,
          graphApiVersion: deps.graphApiVersion,
          to: turn.waId,
          text: replyText,
          fetch: deps.fetch,
        }).catch((err: unknown): import("./whatsappSender.ts").WhatsAppSendResult => ({
          ok: false,
          error: err instanceof Error ? err.message : "send_exception",
        }));

        void deps.runtimeTurnLogger?.logDelivery({
          ts: new Date().toISOString(),
          trace_id: traceId,
          channel: "whatsapp",
          ok: sendResult.ok,
          retry_count: 0,
          provider_message_id: sendResult.ok ? sendResult.messageId : undefined,
          status: undefined,
          error_code: sendResult.ok ? undefined : (sendResult.error ? "whatsapp_send_failed" : undefined),
        }).catch(() => undefined);
        continue;
      }

      // item.type === "audio"
      const audioTurn = item.turn;
      const fetchFn = deps.fetch ?? globalThis.fetch;
      const apiKey = deps.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "";

      const downloadResult = await downloadWhatsAppMedia(
        audioTurn.mediaId,
        deps.accessToken,
        undefined,
        deps.graphApiVersion,
        fetchFn,
      );
      if (!downloadResult.ok) {
        await sendWhatsAppMessage({
          accessToken: deps.accessToken,
          phoneNumberId: deps.phoneNumberId,
          graphApiVersion: deps.graphApiVersion,
          to: audioTurn.waId,
          text: "Не удалось обработать голосовое сообщение. Попробуйте ещё раз или напишите текстом.",
          fetch: fetchFn,
        }).catch(() => undefined);
        continue;
      }

      const transcription = await transcribeAudio(
        {
          channel: "whatsapp",
          message_id: audioTurn.messageId,
          external_user_id: audioTurn.waId,
          mime_type: audioTurn.mime_type,
          bytes: downloadResult.bytes!,
        },
        apiKey,
        undefined,
        fetchFn,
      );
      if (!transcription.ok || !transcription.text) {
        await sendWhatsAppMessage({
          accessToken: deps.accessToken,
          phoneNumberId: deps.phoneNumberId,
          graphApiVersion: deps.graphApiVersion,
          to: audioTurn.waId,
          text: "Не удалось обработать голосовое сообщение. Попробуйте ещё раз или напишите текстом.",
          fetch: fetchFn,
        }).catch(() => undefined);
        continue;
      }

      const phone = normalizeWhatsAppPhone(audioTurn.waId);
      const audioRuntimeBody = {
        clinic_code: deps.clinicId,
        channel: "whatsapp" as const,
        external_user_id: audioTurn.waId,
        chat_id: audioTurn.waId,
        text: transcription.text,
        meta: {
          message_id: audioTurn.messageId,
          wa_id: audioTurn.waId,
          phone_number: phone,
          phone_source: "whatsapp_sender",
          timestamp: audioTurn.timestamp,
          input_modality: "voice",
          original_mime_type: audioTurn.mime_type,
        },
      };

      const trustedChannelContact = {
        phone_number: phone,
        phone_source: "whatsapp_sender" as const,
        phone_consent: false as const,
        phone_collected_at: new Date().toISOString(),
      };

      let audioTraceId = "";
      const audioResult = await runRuntimeTurnOrchestrated(audioRuntimeBody, deps, {
        trustedChannelContact,
        requireInboundRegistration: true,
      }).catch(
        (): { outcome: "error"; fallbackPayload: { final_patient_reply: string; trace_id: string } } => ({
          outcome: "error",
          fallbackPayload: { final_patient_reply: "", trace_id: "" },
        }),
      );

      if (audioResult.outcome === "duplicate" || audioResult.outcome === "inbound_registration_failed") {
        continue;
      }

      let audioReplyText: string | null = null;
      if (audioResult.outcome === "success") {
        audioReplyText = audioResult.payload.final_patient_reply || null;
        audioTraceId = audioResult.payload.trace_id;
      } else if (audioResult.outcome === "error") {
        audioReplyText = audioResult.fallbackPayload.final_patient_reply || null;
        audioTraceId = audioResult.fallbackPayload.trace_id;
      }

      if (!audioReplyText || !audioReplyText.trim()) {
        continue;
      }

      const audioSendResult = await sendWhatsAppMessage({
        accessToken: deps.accessToken,
        phoneNumberId: deps.phoneNumberId,
        graphApiVersion: deps.graphApiVersion,
        to: audioTurn.waId,
        text: audioReplyText,
        fetch: fetchFn,
      }).catch((err: unknown): import("./whatsappSender.ts").WhatsAppSendResult => ({
        ok: false,
        error: err instanceof Error ? err.message : "send_exception",
      }));

      void deps.runtimeTurnLogger?.logDelivery({
        ts: new Date().toISOString(),
        trace_id: audioTraceId,
        channel: "whatsapp",
        ok: audioSendResult.ok,
        retry_count: 0,
        provider_message_id: audioSendResult.ok ? audioSendResult.messageId : undefined,
        status: undefined,
        error_code: audioSendResult.ok ? undefined : (audioSendResult.error ? "whatsapp_send_failed" : undefined),
      }).catch(() => undefined);
    }

    reply.code(200).send({ ok: true });
  });
}

function asQueryString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function asHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

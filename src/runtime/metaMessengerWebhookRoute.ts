import {
  normalizeMetaMessengerPayload,
  verifyMetaWebhookSignature,
} from "./metaMessengerWebhookAdapter.ts";
import { sendMetaMessengerMessage } from "./metaMessengerSender.ts";
import {
  runRuntimeTurnOrchestrated,
  type RuntimeTurnOrchestratorDeps,
} from "./runtimeTurnOrchestrator.ts";

export interface MetaMessengerWebhookRouteDeps extends RuntimeTurnOrchestratorDeps {
  pageAccessToken: string;
  pageId: string;
  verifyToken: string;
  appSecret: string | null;
  graphApiVersion: string;
  clinicCode: string;
  fetch?: typeof globalThis.fetch;
}

export interface MetaMessengerGetRequest {
  query: Record<string, string | string[] | undefined>;
}

export interface MetaMessengerPostRequest {
  body: unknown;
  rawBody: Buffer | null;
  headers: Record<string, string | string[] | undefined>;
}

export interface MetaMessengerWebhookReply {
  code(n: number): MetaMessengerWebhookReply;
  send(payload: unknown): void;
}

export interface MetaMessengerRouteApp {
  get(
    path: string,
    handler: (
      request: MetaMessengerGetRequest,
      reply: MetaMessengerWebhookReply,
    ) => Promise<void>,
  ): void;
  post(
    path: string,
    handler: (
      request: MetaMessengerPostRequest,
      reply: MetaMessengerWebhookReply,
    ) => Promise<void>,
  ): void;
}

export function registerMetaMessengerWebhookRoute(
  app: MetaMessengerRouteApp,
  deps: MetaMessengerWebhookRouteDeps,
): void {
  // GET: Meta Webhooks verification handshake.
  app.get("/webhooks/meta", async (request, reply) => {
    const mode = asQueryString(request.query["hub.mode"]);
    const token = asQueryString(request.query["hub.verify_token"]);
    const challenge = asQueryString(request.query["hub.challenge"]);

    if (mode === "subscribe" && token === deps.verifyToken) {
      reply.code(200).send(challenge ?? "");
      return;
    }

    reply.code(403).send({ error: "Forbidden" });
  });

  // POST: Messenger webhook deliveries.
  app.post("/webhooks/meta", async (request, reply) => {
    if (deps.appSecret) {
      if (request.rawBody === null) {
        reply.code(400).send({ error: "Raw body unavailable for signature verification" });
        return;
      }

      const signature = asHeaderString(request.headers["x-hub-signature-256"]);
      const verified = verifyMetaWebhookSignature({
        rawBody: request.rawBody,
        signatureHeader: signature,
        appSecret: deps.appSecret,
      });

      if (!verified.ok) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
    }

    const normalized = normalizeMetaMessengerPayload(
      request.body,
      deps.clinicCode,
      deps.pageId,
    );

    // Meta expects a fast 2xx acknowledgement for webhook events we do not
    // consume. Unknown object/event types must not trigger the patient LLM.
    if (!normalized.ok) {
      reply.code(200).send({ ok: true });
      return;
    }

    for (const turn of normalized.turns) {
      let traceId = "";

      const result = await runRuntimeTurnOrchestrated(
        turn.runtimeBody,
        deps,
        { requireInboundRegistration: true },
      ).catch(
        (): {
          outcome: "error";
          fallbackPayload: { final_patient_reply: string; trace_id: string };
        } => ({
          outcome: "error",
          fallbackPayload: { final_patient_reply: "", trace_id: "" },
        }),
      );

      if (
        result.outcome === "duplicate"
        || result.outcome === "inbound_registration_failed"
      ) {
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

      if (!replyText?.trim()) continue;

      const sendResult = await sendMetaMessengerMessage({
        pageAccessToken: deps.pageAccessToken,
        pageId: deps.pageId,
        graphApiVersion: deps.graphApiVersion,
        recipientId: turn.senderId,
        text: replyText,
        fetch: deps.fetch,
      }).catch((error: unknown): import("./metaMessengerSender.ts").MetaMessengerSendResult => ({
        ok: false,
        error: error instanceof Error ? error.message : "send_exception",
      }));

      void deps.runtimeTurnLogger?.logDelivery({
        ts: new Date().toISOString(),
        trace_id: traceId,
        channel: "messenger",
        ok: sendResult.ok,
        retry_count: 0,
        provider_message_id: sendResult.ok ? sendResult.messageId : undefined,
        status: undefined,
        error_code: sendResult.ok ? undefined : "meta_messenger_send_failed",
      }).catch(() => undefined);
    }

    reply.code(200).send({ ok: true });
  });
}

function asQueryString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asHeaderString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

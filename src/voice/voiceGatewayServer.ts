import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import type { VoiceConfig } from "./voiceConfig.ts";
import { createElevenLabsBrainCallbacks } from "./elevenLabsBrain.ts";
import { registerTwilioIncomingRoute } from "./twilioIncomingRoute.ts";
import { createMediaBridgeHandler, type WebSocketConnection } from "./twilioMediaBridge.ts";
import { safeVoiceLog } from "./safeVoiceLogger.ts";
import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Extracted auth helper — validates that the x-twilio-signature header matches
 * the canonical WebSocket URL for the media-stream endpoint. Testable independently.
 */
export function validateTwilioWsSignature(
  authToken: string,
  publicBaseUrl: string,
  signature: string,
): boolean {
  const wsUrl = `${publicBaseUrl}/voice/media-stream`;
  return validateRequest(authToken, signature, wsUrl, {});
}

export function createVoiceGatewayServer(config: VoiceConfig) {
  const app = Fastify();
  const elevenlabs = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });

  let attachment: { close(): Promise<void> } | null = null;
  let ready = false;

  async function start(): Promise<void> {
    await app.register(fastifyFormBody);
    await app.register(fastifyWebsocket);

    app.get("/voice/health", async (_req, reply) => {
      if (!ready) {
        reply.code(503);
        return { ok: false, status: "starting" };
      }
      return { ok: true };
    });

    const incomingRouteApp = {
      post(
        path: string,
        handler: (req: { headers: Record<string, string | string[] | undefined>; body: Record<string, string>; url: string }, reply: { code(n: number): typeof reply; header(k: string, v: string): typeof reply; send(d: string): void }) => Promise<void>,
      ) {
        app.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
          const url =
            config.voicePublicBaseUrl
              ? `${config.voicePublicBaseUrl}${request.url}`
              : `${request.protocol}://${request.hostname}${request.url}`;

          const replyAdapter = {
            code(n: number) { reply.code(n); return replyAdapter; },
            header(k: string, v: string) { reply.header(k, v); return replyAdapter; },
            send(d: string) { reply.send(d); },
          };

          await handler(
            {
              headers: request.headers as Record<string, string | string[] | undefined>,
              body: request.body as Record<string, string>,
              url,
            },
            replyAdapter,
          );
        });
      },
    };

    registerTwilioIncomingRoute(incomingRouteApp, {
      twilioAuthToken: config.twilioAuthToken,
      voicePublicBaseUrl: config.voicePublicBaseUrl,
    });

    const bridgeHandler = createMediaBridgeHandler({
      elevenlabs,
      speechEngineId: config.elevenLabsSpeechEngineId,
      voiceFirstMessage: config.voiceFirstMessage,
      twilioAuthToken: config.twilioAuthToken,
    });

    app.get("/voice/media-stream", { websocket: true }, (socket, request: FastifyRequest) => {
      // Fail-closed: reject if auth token or public URL missing
      if (!config.twilioAuthToken || !config.voicePublicBaseUrl) {
        safeVoiceLog({ event: "bridge_ws_auth_rejected", stage: "503_missing_config", connection_state: "rejected" });
        socket.close();
        return;
      }

      const sig = (request.headers["x-twilio-signature"] as string | undefined) ?? "";
      const valid = validateTwilioWsSignature(config.twilioAuthToken, config.voicePublicBaseUrl, sig);
      if (!valid) {
        safeVoiceLog({ event: "bridge_ws_auth_rejected", stage: "403", connection_state: "rejected" });
        socket.close();
        return;
      }

      const wsConn: WebSocketConnection = {
        on(event: string, cb: (data: Buffer | string | Error) => void) {
          (socket as unknown as { on(e: string, cb: (...args: unknown[]) => void): void }).on(event, cb as (...args: unknown[]) => void);
        },
        send(data: string) { socket.send(data); },
        close() { socket.close(); },
      };

      bridgeHandler(wsConn);
    });

    await app.listen({ port: config.voicePort, host: "0.0.0.0" });

    safeVoiceLog({ event: "voice_gateway_started", stage: `port:${config.voicePort}` });

    const brainCallbacks = createElevenLabsBrainCallbacks({
      runtimeBaseUrl: config.runtimeBaseUrl,
      runtimeApiKey: config.runtimeApiKey,
      voiceClinicCode: config.voiceClinicCode,
      voiceFallbackReply: config.voiceFallbackReply,
    });

    const engine = await elevenlabs.speechEngine.get(config.elevenLabsSpeechEngineId);
    attachment = engine.attach(app.server, "/voice/brain", brainCallbacks);
    ready = true;

    safeVoiceLog({ event: "voice_brain_attached", stage: "ready" });
  }

  async function stop(): Promise<void> {
    try { await attachment?.close(); } catch {}
    await app.close();
    safeVoiceLog({ event: "voice_gateway_stopped" });
  }

  return { start, stop };
}

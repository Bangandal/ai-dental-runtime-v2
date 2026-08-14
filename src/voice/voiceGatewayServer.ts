import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import type { VoiceConfig } from "./voiceConfig.ts";
import { buildTwilioMediaStreamUrl } from "./twilioUrls.ts";
export { buildTwilioMediaStreamUrl } from "./twilioUrls.ts";
import { createElevenLabsBrainCallbacks } from "./elevenLabsBrain.ts";
import {
  createElevenLabsBrainWebsocketHandler,
  type ElevenLabsBrainEngine,
} from "./elevenLabsBrainWebsocket.ts";
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
  const wsUrl = buildTwilioMediaStreamUrl(publicBaseUrl);
  return validateRequest(authToken, signature, wsUrl, {});
}

export function createVoiceGatewayServer(config: VoiceConfig) {
  const app = Fastify();
  const elevenlabs = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });

  let brainEngine: ElevenLabsBrainEngine | null = null;
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

    const brainCallbacks = createElevenLabsBrainCallbacks({
      runtimeBaseUrl: config.runtimeBaseUrl,
      runtimeApiKey: config.runtimeApiKey,
      voiceClinicCode: config.voiceClinicCode,
      voiceFallbackReply: config.voiceFallbackReply,
    });

    // @fastify/websocket must own both websocket paths. Register /voice/brain
    // before listen() so Fastify upgrades it instead of returning 404. The
    // ElevenLabs SDK still verifies the signed upstream JWT and creates the
    // SpeechEngineSession after Fastify accepts the websocket upgrade.
    app.get(
      "/voice/brain",
      { websocket: true },
      createElevenLabsBrainWebsocketHandler({
        getEngine: () => brainEngine,
        callbacks: brainCallbacks,
      }),
    );

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

    // Keep health fail-closed until the Speech Engine resource is loaded. The
    // route already exists, so an early connection is closed as not-ready
    // rather than falling through to Fastify's 404 handler.
    brainEngine = await elevenlabs.speechEngine.get(config.elevenLabsSpeechEngineId);
    ready = true;

    safeVoiceLog({ event: "voice_brain_attached", stage: "ready" });
  }

  async function stop(): Promise<void> {
    ready = false;
    brainEngine = null;
    await app.close();
    safeVoiceLog({ event: "voice_gateway_stopped" });
  }

  return { start, stop };
}

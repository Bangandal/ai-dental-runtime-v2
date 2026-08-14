import type { FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { SpeechEngineResource } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/SpeechEngineResource.js";
import type { SpeechEngineSession } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/SpeechEngineSession.js";
import {
  isAbortError,
  type SpeechEngineCallbacks,
} from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/types.js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

export type ElevenLabsBrainEngine = Pick<SpeechEngineResource, "verifyRequest" | "createSession">;

export interface ElevenLabsBrainWebsocketDeps {
  /**
   * The Speech Engine resource is loaded after the HTTP listener starts so
   * /voice/health can truthfully report 503 while setup is still in progress.
   * The websocket route itself must be registered before app.listen().
   */
  getEngine(): ElevenLabsBrainEngine | null;
  callbacks: SpeechEngineCallbacks;
}

/**
 * Build the Fastify websocket handler for ElevenLabs Speech Engine upstream.
 *
 * @fastify/websocket already owns the HTTP server's `upgrade` event for the
 * Twilio media websocket. Registering /voice/brain through the same plugin
 * avoids a competing `engine.attach()` upgrade listener, which otherwise lets
 * Fastify reject the unknown route with 404 before the SDK can claim it.
 */
export function createElevenLabsBrainWebsocketHandler(deps: ElevenLabsBrainWebsocketDeps) {
  return async function handleElevenLabsBrainWebsocket(
    socket: WebSocket,
    request: Pick<FastifyRequest, "headers">,
  ): Promise<void> {
    const engine = deps.getEngine();
    if (!engine) {
      safeVoiceLog({
        event: "brain_ws_auth_rejected",
        stage: "503_engine_not_ready",
        connection_state: "rejected",
      });
      socket.close(1013, "Speech Engine not ready");
      return;
    }

    let verified = false;
    try {
      verified = await engine.verifyRequest({
        headers: request.headers as Record<string, string | string[] | undefined>,
      });
    } catch {
      // Authentication errors must fail closed. Never log the JWT/header value.
      safeVoiceLog({
        event: "brain_ws_auth_rejected",
        stage: "verification_error",
        connection_state: "rejected",
      });
      socket.close(1008, "Unauthorized");
      return;
    }

    if (!verified) {
      safeVoiceLog({
        event: "brain_ws_auth_rejected",
        stage: "401",
        connection_state: "rejected",
      });
      socket.close(1008, "Unauthorized");
      return;
    }

    const session = engine.createSession(socket);
    wireElevenLabsBrainCallbacks(session, deps.callbacks);
    safeVoiceLog({ event: "brain_ws_session_created", stage: "ready" });
  };
}

/**
 * Mirrors the ElevenLabs SDK attach() callback wiring while keeping Fastify in
 * sole control of websocket routing/upgrades.
 */
export function wireElevenLabsBrainCallbacks(
  session: SpeechEngineSession,
  callbacks: SpeechEngineCallbacks,
): void {
  const { onInit, onTranscript, onClose, onDisconnect, onError } = callbacks;

  if (onInit) {
    session.on("init", (conversationId) => {
      onInit.call(session, conversationId, session);
    });
  }

  if (onTranscript) {
    session.on("user_transcript", (transcript, signal) => {
      Promise.resolve(onTranscript.call(session, transcript, signal, session)).catch((err: unknown) => {
        if (isAbortError(err)) return;
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.call(session, error, session);
      });
    });
  }

  if (onClose) {
    session.on("close", () => {
      onClose.call(session, session);
    });
  }

  if (onDisconnect) {
    session.on("disconnected", () => {
      onDisconnect.call(session, session);
    });
  }

  if (onError) {
    session.on("error", (error) => {
      onError.call(session, error, session);
    });
  }
}

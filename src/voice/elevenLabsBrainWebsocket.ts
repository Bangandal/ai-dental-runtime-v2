import type { FastifyReply, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { SpeechEngineResource } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/SpeechEngineResource.js";
import type { SpeechEngineSession } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/SpeechEngineSession.js";
import type { SpeechEngineCallbacks } from "@elevenlabs/elevenlabs-js/dist/wrapper/speech-engine/types.js";
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
 * Authenticate ElevenLabs in Fastify's preValidation phase, before the HTTP
 * request is upgraded to a websocket. This is both fail-closed and avoids the
 * message-loss race that would exist if we awaited verification inside the
 * websocket handler before SpeechEngineSession attached its message listener.
 */
export function createElevenLabsBrainPreValidation(deps: ElevenLabsBrainWebsocketDeps) {
  return async function validateElevenLabsBrainRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const engine = deps.getEngine();
    if (!engine) {
      safeVoiceLog({
        event: "brain_ws_auth_rejected",
        stage: "503_engine_not_ready",
        connection_state: "rejected",
      });
      reply.code(503).send({ ok: false, error: "speech_engine_not_ready" });
      return;
    }

    let verified = false;
    try {
      verified = await engine.verifyRequest({
        headers: request.headers as Record<string, string | string[] | undefined>,
      });
    } catch {
      // Never log the signed authorization JWT or any request secrets.
      safeVoiceLog({
        event: "brain_ws_auth_rejected",
        stage: "verification_error",
        connection_state: "rejected",
      });
      reply.code(401).send({ ok: false, error: "unauthorized" });
      return;
    }

    if (!verified) {
      safeVoiceLog({
        event: "brain_ws_auth_rejected",
        stage: "401",
        connection_state: "rejected",
      });
      reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  };
}

/**
 * Fastify owns the websocket upgrade. Authentication has already completed in
 * preValidation, so this handler stays synchronous and immediately creates the
 * SDK session, attaching message listeners before ElevenLabs can send `init`.
 */
export function createElevenLabsBrainWebsocketHandler(deps: ElevenLabsBrainWebsocketDeps) {
  return function handleElevenLabsBrainWebsocket(socket: WebSocket): void {
    const engine = deps.getEngine();
    if (!engine) {
      // Defensive race guard: the engine could only disappear during shutdown.
      safeVoiceLog({
        event: "brain_ws_auth_rejected",
        stage: "engine_lost_after_upgrade",
        connection_state: "rejected",
      });
      socket.close(1013, "Speech Engine not ready");
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

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && /\babort/i.test(err.message)) return true;
  return false;
}

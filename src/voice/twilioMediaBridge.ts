import WebSocket from "ws";
import type { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

const MAX_AUDIO_BUFFER = 200;

export interface TwilioMediaBridgeDeps {
  elevenlabs: ElevenLabsClient;
  speechEngineId: string;
  twilioAuthToken?: string;
}

export interface TwilioMediaBridgeApp {
  websocket(
    path: string,
    handler: (connection: WebSocketConnection, req: IncomingRequest) => void,
  ): void;
}

export interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
  url: string;
}

export interface WebSocketConnection {
  on(event: "message", handler: (data: Buffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export function createMediaBridgeHandler(deps: TwilioMediaBridgeDeps) {
  return function handleTwilioConnection(twilioWs: WebSocketConnection): void {
    let streamSid = "";
    let callSid = "";
    let elWs: WebSocket | null = null;
    let closed = false;
    // Fix 4: buffer early Twilio audio frames before EL OPEN
    const audioBuffer: string[] = [];
    let elReady = false;

    // Fix 6: idempotent close — handles all shutdown paths
    function closeAll(reason?: string) {
      if (closed) return;
      closed = true;
      if (reason) {
        safeVoiceLog({ event: "bridge_close", call_sid: callSid, stage: reason, connection_state: "closing" });
      }
      try {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      } catch {}
      try {
        if (elWs && elWs.readyState !== WebSocket.CLOSED) elWs.close();
      } catch {}
      try {
        twilioWs.close();
      } catch {}
    }

    function sendToElevenLabs(payload: string) {
      // Fix 1: correct user audio envelope
      if (elWs && elWs.readyState === WebSocket.OPEN) {
        elWs.send(JSON.stringify({ user_audio_chunk: payload }));
      }
    }

    twilioWs.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const event = msg.event as string | undefined;

      if (event === "connected") {
        safeVoiceLog({ event: "bridge_twilio_connected", connection_state: "connected" });
        return;
      }

      if (event === "start") {
        const start = msg.start as Record<string, string> | undefined;
        streamSid = start?.streamSid ?? "";
        callSid = start?.callSid ?? "";

        safeVoiceLog({ event: "bridge_call_start", call_sid: callSid, stream_sid: streamSid });

        deps.elevenlabs.conversationalAi.conversations
          .getSignedUrl({ agentId: deps.speechEngineId })
          .then((res) => {
            if (closed) return;

            elWs = new WebSocket(res.signedUrl);

            elWs.on("open", () => {
              if (closed) {
                elWs?.close();
                return;
              }
              safeVoiceLog({
                event: "bridge_elevenlabs_connected",
                call_sid: callSid,
                connection_state: "connected",
              });

              // Fix 2: send conversation_initiation_client_data on EL OPEN before audio
              elWs!.send(JSON.stringify({ type: "conversation_initiation_client_data" }));

              // Fix 4: flush buffered audio in order
              elReady = true;
              for (const chunk of audioBuffer) {
                sendToElevenLabs(chunk);
              }
              audioBuffer.length = 0;
            });

            elWs.on("message", (data) => {
              let elMsg: Record<string, unknown>;
              try {
                elMsg = JSON.parse(data.toString());
              } catch {
                return;
              }

              const type = elMsg.type as string | undefined;

              if (type === "audio") {
                const audioEvent = elMsg.audio_event as Record<string, unknown> | undefined;
                const payload = audioEvent?.audio_base_64 as string | undefined;
                if (payload) {
                  twilioWs.send(
                    JSON.stringify({ event: "media", streamSid, media: { payload } }),
                  );
                }
              } else if (type === "interruption") {
                twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
              } else if (type === "ping") {
                // Fix 3: preserve event_id in pong
                const pingEvent = elMsg.ping_event as Record<string, unknown> | undefined;
                const eventId = pingEvent?.event_id;
                elWs?.send(JSON.stringify({ type: "pong", event_id: eventId }));
              }
            });

            elWs.on("close", () => {
              safeVoiceLog({
                event: "bridge_elevenlabs_closed",
                call_sid: callSid,
                connection_state: "closed",
              });
              closeAll("el_close");
            });

            elWs.on("error", (err) => {
              safeVoiceLog({
                event: "bridge_elevenlabs_error",
                call_sid: callSid,
                error_code: err.name,
              });
              closeAll("el_error");
            });
          })
          .catch((err: unknown) => {
            safeVoiceLog({
              event: "bridge_signed_url_error",
              call_sid: callSid,
              error_code: err instanceof Error ? err.name : "unknown",
            });
            // Fix 6: signed URL failure → fail-closed
            closeAll("signed_url_error");
          });

        return;
      }

      if (event === "media") {
        const media = msg.media as Record<string, string> | undefined;
        const payload = media?.payload;
        if (!payload) return;

        if (elReady) {
          sendToElevenLabs(payload);
        } else {
          // Fix 4: buffer frames while EL connection is establishing
          if (audioBuffer.length < MAX_AUDIO_BUFFER) {
            audioBuffer.push(payload);
          }
        }
        return;
      }

      if (event === "stop") {
        safeVoiceLog({ event: "bridge_call_stop", call_sid: callSid, stream_sid: streamSid });
        closeAll("twilio_stop");
        return;
      }
    });

    twilioWs.on("close", () => {
      safeVoiceLog({
        event: "bridge_twilio_closed",
        call_sid: callSid,
        connection_state: "closed",
      });
      closeAll("twilio_closed");
    });

    twilioWs.on("error", (err) => {
      safeVoiceLog({
        event: "bridge_twilio_error",
        call_sid: callSid,
        error_code: err.name,
      });
      closeAll("twilio_error");
    });
  };
}

export function registerTwilioMediaBridgeRoute(
  app: TwilioMediaBridgeApp,
  deps: TwilioMediaBridgeDeps,
): void {
  const handler = createMediaBridgeHandler(deps);
  app.websocket("/voice/media-stream", (ws, _req) => handler(ws));
}

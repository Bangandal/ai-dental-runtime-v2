import WebSocket from "ws";
import type { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

const MAX_AUDIO_BUFFER = 200;

export interface WebSocketLike {
  on(event: "open", handler: () => void): void;
  on(event: "message", handler: (data: Buffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}

export interface TwilioMediaBridgeDeps {
  elevenlabs: ElevenLabsClient;
  speechEngineId: string;
  voiceFirstMessage: string;
  twilioAuthToken?: string;
  /** Injectable WebSocket factory — default: new WebSocket(url) */
  createElevenLabsWebSocket?: (url: string) => WebSocketLike;
}

export interface WebSocketConnection {
  on(event: "message", handler: (data: Buffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export function createMediaBridgeHandler(deps: TwilioMediaBridgeDeps) {
  const wsFactory = deps.createElevenLabsWebSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  return function handleTwilioConnection(twilioWs: WebSocketConnection): void {
    let streamSid = "";
    let callSid = "";
    let elWs: WebSocketLike | null = null;
    let closed = false;
    const audioBuffer: string[] = [];
    let elReady = false;

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

            elWs = wsFactory(res.signedUrl);

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

              // Send initiation data first (spec section 3): includes first_message override
              elWs!.send(JSON.stringify({
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                  agent: {
                    first_message: deps.voiceFirstMessage,
                  },
                },
              }));

              // Flush buffered early audio in order
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
          if (audioBuffer.length < MAX_AUDIO_BUFFER) {
            audioBuffer.push(payload);
          } else {
            // Buffer full: fail-closed rather than silently dropping frames
            safeVoiceLog({
              event: "voice_buffer_overflow",
              call_sid: callSid,
              buffered_frames: audioBuffer.length,
            });
            audioBuffer.length = 0;
            closeAll("buffer_overflow");
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


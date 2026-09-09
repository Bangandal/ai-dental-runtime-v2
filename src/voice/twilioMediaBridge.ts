import WebSocket from "ws";
import type { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";
import type { VoiceCallContextRegistry } from "./voiceCallContext.ts";

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
  callRegistry?: VoiceCallContextRegistry;
  /** Injectable WebSocket factory, default: new WebSocket(url). */
  createElevenLabsWebSocket?: (url: string) => WebSocketLike;
}

export interface WebSocketConnection {
  on(event: "message", handler: (data: Buffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
      if (callSid) deps.callRegistry?.finishByCallSid(callSid);
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

      const event = stringValue(msg.event);

      if (event === "connected") {
        safeVoiceLog({ event: "bridge_twilio_connected", connection_state: "connected" });
        return;
      }

      if (event === "start") {
        const start = record(msg.start);
        streamSid = stringValue(start?.streamSid);
        callSid = stringValue(start?.callSid);
        const custom = record(start?.customParameters);
        const callerPhone = stringValue(custom?.caller_phone);
        const calledNumber = stringValue(custom?.called_number);

        if (callSid) {
          deps.callRegistry?.register({
            callSid,
            streamSid,
            ...(callerPhone ? { callerPhone } : {}),
            ...(calledNumber ? { calledNumber } : {}),
          });
        }

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

              elWs!.send(JSON.stringify({
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                  agent: {
                    first_message: deps.voiceFirstMessage,
                  },
                },
              }));

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

              const type = stringValue(elMsg.type);

              if (type === "conversation_initiation_metadata") {
                const metadata = record(elMsg.conversation_initiation_metadata_event);
                const conversationId = stringValue(metadata?.conversation_id);
                if (conversationId && callSid) {
                  deps.callRegistry?.bindConversation(callSid, conversationId);
                  safeVoiceLog({
                    event: "bridge_conversation_bound",
                    call_sid: callSid,
                    conversation_id: conversationId,
                  });
                }
              } else if (type === "audio") {
                const audioEvent = record(elMsg.audio_event);
                const payload = stringValue(audioEvent?.audio_base_64);
                if (payload) {
                  twilioWs.send(
                    JSON.stringify({ event: "media", streamSid, media: { payload } }),
                  );
                }
              } else if (type === "interruption") {
                twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
              } else if (type === "ping") {
                const pingEvent = record(elMsg.ping_event);
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
        const media = record(msg.media);
        const payload = stringValue(media?.payload);
        if (!payload) return;

        if (elReady) {
          sendToElevenLabs(payload);
        } else {
          if (audioBuffer.length < MAX_AUDIO_BUFFER) {
            audioBuffer.push(payload);
          } else {
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

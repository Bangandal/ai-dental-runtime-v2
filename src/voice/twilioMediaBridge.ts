import WebSocket from "ws";
import type { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

export interface TwilioMediaBridgeDeps {
  elevenlabs: ElevenLabsClient;
  speechEngineId: string;
}

export interface TwilioMediaBridgeApp {
  websocket(
    path: string,
    handler: (connection: WebSocketConnection) => void,
  ): void;
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

    function closeAll() {
      if (closed) return;
      closed = true;
      try {
        if (elWs && elWs.readyState === WebSocket.OPEN) elWs.close();
      } catch {}
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
              safeVoiceLog({
                event: "bridge_elevenlabs_connected",
                call_sid: callSid,
                connection_state: "connected",
              });
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
                elWs?.send(JSON.stringify({ type: "pong" }));
              }
            });

            elWs.on("close", () => {
              safeVoiceLog({
                event: "bridge_elevenlabs_closed",
                call_sid: callSid,
                connection_state: "closed",
              });
              closeAll();
            });

            elWs.on("error", (err) => {
              safeVoiceLog({
                event: "bridge_elevenlabs_error",
                call_sid: callSid,
                error_code: err.name,
              });
              closeAll();
            });
          })
          .catch((err: unknown) => {
            safeVoiceLog({
              event: "bridge_signed_url_error",
              call_sid: callSid,
              error_code: err instanceof Error ? err.name : "unknown",
            });
            closeAll();
          });

        return;
      }

      if (event === "media") {
        const media = msg.media as Record<string, string> | undefined;
        const payload = media?.payload;
        if (payload && elWs && elWs.readyState === WebSocket.OPEN) {
          elWs.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: payload } }));
        }
        return;
      }

      if (event === "stop") {
        safeVoiceLog({ event: "bridge_call_stop", call_sid: callSid, stream_sid: streamSid });
        closeAll();
        return;
      }
    });

    twilioWs.on("close", () => {
      safeVoiceLog({
        event: "bridge_twilio_closed",
        call_sid: callSid,
        connection_state: "closed",
      });
      closeAll();
    });

    twilioWs.on("error", (err) => {
      safeVoiceLog({
        event: "bridge_twilio_error",
        call_sid: callSid,
        error_code: err.name,
      });
      closeAll();
    });
  };
}

export function registerTwilioMediaBridgeRoute(
  app: TwilioMediaBridgeApp,
  deps: TwilioMediaBridgeDeps,
): void {
  const handler = createMediaBridgeHandler(deps);
  app.websocket("/voice/media-stream", handler);
}

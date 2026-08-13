import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

export interface TwilioIncomingRouteDeps {
  twilioAuthToken?: string;
  voicePublicBaseUrl?: string;
}

export interface TwilioIncomingRouteApp {
  post(
    path: string,
    handler: (req: TwilioIncomingRequest, reply: TwilioIncomingReply) => Promise<void>,
  ): void;
}

export interface TwilioIncomingRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, string>;
  url: string; // full URL including host
}

export interface TwilioIncomingReply {
  code(n: number): TwilioIncomingReply;
  header(name: string, value: string): TwilioIncomingReply;
  send(payload: string): void;
}

export function registerTwilioIncomingRoute(
  app: TwilioIncomingRouteApp,
  deps: TwilioIncomingRouteDeps,
): void {
  app.post("/voice/incoming", async (req, reply) => {
    if (!deps.voicePublicBaseUrl) {
      safeVoiceLog({ event: "incoming_no_public_base_url", stage: "503" });
      reply.code(503).send("Voice gateway not configured: missing VOICE_PUBLIC_BASE_URL");
      return;
    }

    if (deps.twilioAuthToken) {
      const signature = (req.headers["x-twilio-signature"] as string | undefined) ?? "";
      const valid = validateRequest(deps.twilioAuthToken, signature, req.url, req.body);
      if (!valid) {
        safeVoiceLog({ event: "incoming_invalid_signature", stage: "403" });
        reply.code(403).send("Forbidden");
        return;
      }
    }

    const wssUrl = `${deps.voicePublicBaseUrl.replace(/^http/, "ws")}/voice/media-stream`;

    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    connect.stream({ url: wssUrl });

    safeVoiceLog({ event: "incoming_call_accepted", stage: "twiml_response" });

    reply
      .code(200)
      .header("Content-Type", "text/xml")
      .send(twiml.toString());
  });
}

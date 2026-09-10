import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";
import { buildTwilioMediaStreamUrl } from "./twilioUrls.ts";

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
    // Fail closed: both token and public URL are required.
    if (!deps.twilioAuthToken || !deps.voicePublicBaseUrl) {
      safeVoiceLog({ event: "incoming_not_configured", stage: "503" });
      reply.code(503).send("Voice gateway not configured: missing TWILIO_AUTH_TOKEN or VOICE_PUBLIC_BASE_URL");
      return;
    }

    const signature = (req.headers["x-twilio-signature"] as string | undefined) ?? "";
    const valid = validateRequest(deps.twilioAuthToken, signature, req.url, req.body);
    if (!valid) {
      safeVoiceLog({ event: "incoming_invalid_signature", stage: "403" });
      reply.code(403).send("Forbidden");
      return;
    }

    const wssUrl = buildTwilioMediaStreamUrl(deps.voicePublicBaseUrl);

    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    const stream = connect.stream({ url: wssUrl });

    // Twilio includes these values in start.customParameters on the authenticated media
    // stream. They stay inside the voice gateway and are never exposed to the model.
    if (req.body.From) stream.parameter({ name: "caller_phone", value: req.body.From });
    if (req.body.To) stream.parameter({ name: "called_number", value: req.body.To });

    safeVoiceLog({ event: "incoming_call_accepted", call_sid: req.body.CallSid, stage: "twiml_response" });

    reply
      .code(200)
      .header("Content-Type", "text/xml")
      .send(twiml.toString());
  });
}

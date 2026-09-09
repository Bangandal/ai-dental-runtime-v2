import twilio from "twilio";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";
import { safeVoiceLog } from "./safeVoiceLogger.ts";

export interface VoiceTransferResult {
  ok: boolean;
  reason?: "not_configured" | "provider_error";
}

export interface VoiceTransferController {
  transfer(callSid: string, requestId: string): Promise<VoiceTransferResult>;
}

interface TwilioCallUpdateClient {
  calls(callSid: string): {
    update(input: { twiml: string }): Promise<unknown>;
  };
}

export interface VoiceTransferControllerDeps {
  accountSid?: string;
  authToken?: string;
  humanTransferNumber?: string;
  client?: TwilioCallUpdateClient;
}

export function buildHumanTransferTwiml(humanTransferNumber: string): string {
  const response = new VoiceResponse();
  const dial = response.dial({ answerOnBridge: true });
  dial.number(humanTransferNumber);
  return response.toString();
}

export function createVoiceTransferController(deps: VoiceTransferControllerDeps): VoiceTransferController {
  const client = deps.client ?? (
    deps.accountSid && deps.authToken
      ? twilio(deps.accountSid, deps.authToken) as unknown as TwilioCallUpdateClient
      : undefined
  );

  return {
    async transfer(callSid: string, requestId: string): Promise<VoiceTransferResult> {
      if (!client || !deps.humanTransferNumber) {
        safeVoiceLog({
          event: "voice_transfer_skipped",
          call_sid: callSid,
          request_id: requestId,
          stage: "not_configured",
        });
        return { ok: false, reason: "not_configured" };
      }

      try {
        await client.calls(callSid).update({
          twiml: buildHumanTransferTwiml(deps.humanTransferNumber),
        });
        safeVoiceLog({
          event: "voice_transfer_accepted",
          call_sid: callSid,
          request_id: requestId,
          stage: "twilio_call_update",
        });
        return { ok: true };
      } catch (error) {
        safeVoiceLog({
          event: "voice_transfer_failed",
          call_sid: callSid,
          request_id: requestId,
          stage: "twilio_call_update",
          error_code: error instanceof Error ? error.name : "unknown",
        });
        return { ok: false, reason: "provider_error" };
      }
    },
  };
}

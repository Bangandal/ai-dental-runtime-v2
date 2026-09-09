import { createHmac } from "node:crypto";
import type { VoiceCallContext } from "./voiceCallContext.ts";

export interface VoiceRuntimeRequest {
  clinicCode: string;
  conversationId: string;
  patientTranscript: string;
  turnNumber: number;
  signal: AbortSignal;
  callContext?: VoiceCallContext | null;
}

export interface VoiceLiveTransferProof {
  requestId: string;
}

export interface VoiceRuntimeResponse {
  reply: string;
  liveTransfer: VoiceLiveTransferProof | null;
}

export interface RuntimeVoiceClientDeps {
  runtimeBaseUrl: string;
  runtimeApiKey: string;
  voiceIdentityHmacSecret?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableVoiceIdentity(
  conversationId: string,
  callContext: VoiceCallContext | null | undefined,
  secret: string | undefined,
): string {
  const caller = callContext?.callerPhone?.trim();
  if (!caller || !secret) return `voice:conversation:${conversationId}`;
  const digest = createHmac("sha256", secret).update(caller, "utf8").digest("hex");
  return `voice:caller:${digest}`;
}

function findLiveTransferProof(data: Record<string, unknown>): VoiceLiveTransferProof | null {
  const effects = Array.isArray(data.side_effects) ? data.side_effects : [];
  for (const raw of effects) {
    const effect = asRecord(raw);
    if (!effect) continue;
    if (effect.type !== "staff_request" || effect.kind !== "live_transfer" || effect.request_saved !== true) continue;
    const requestId = typeof effect.request_id === "string" ? effect.request_id.trim() : "";
    if (requestId) return { requestId };
  }
  return null;
}

export function createRuntimeVoiceClient(deps: RuntimeVoiceClientDeps) {
  return { callRuntimeTurn };

  async function callRuntimeTurn(req: VoiceRuntimeRequest): Promise<VoiceRuntimeResponse> {
    const combined = AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]);
    const externalUserId = stableVoiceIdentity(
      req.conversationId,
      req.callContext,
      deps.voiceIdentityHmacSecret,
    );

    const body = JSON.stringify({
      clinic_code: req.clinicCode,
      channel: "voice",
      external_user_id: externalUserId,
      chat_id: externalUserId,
      text: req.patientTranscript,
      meta: {
        message_id: `${req.conversationId}:${req.turnNumber}`,
        update_id: `${req.conversationId}:${req.turnNumber}`,
        input_modality: "realtime_voice",
        voice_provider: "elevenlabs",
        voice_conversation_id: req.conversationId,
        ...(req.callContext?.callSid ? { twilio_call_sid: req.callContext.callSid } : {}),
      },
    });

    const response = await fetch(`${deps.runtimeBaseUrl}/runtime/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.runtimeApiKey}`,
      },
      body,
      signal: combined,
    });

    if (!response.ok) {
      throw new Error(`Runtime /runtime/turn returned ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const reply =
      (data.final_patient_reply as string | undefined) ||
      (data.reply_text as string | undefined);

    if (!reply) {
      throw new Error("Runtime response missing final_patient_reply and reply_text");
    }

    return {
      reply,
      liveTransfer: findLiveTransferProof(data),
    };
  }
}

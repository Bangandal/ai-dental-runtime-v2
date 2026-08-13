export interface VoiceRuntimeRequest {
  clinicCode: string;
  conversationId: string;
  patientTranscript: string;
  turnNumber: number;
  signal: AbortSignal;
}

export interface VoiceRuntimeResponse {
  reply: string;
}

export interface RuntimeVoiceClientDeps {
  runtimeBaseUrl: string;
  runtimeApiKey: string;
}

export function createRuntimeVoiceClient(deps: RuntimeVoiceClientDeps) {
  return { callRuntimeTurn };

  async function callRuntimeTurn(req: VoiceRuntimeRequest): Promise<VoiceRuntimeResponse> {
    const combined = AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]);

    const body = JSON.stringify({
      clinic_code: req.clinicCode,
      channel: "voice",
      external_user_id: `elevenlabs:${req.conversationId}`,
      chat_id: `elevenlabs:${req.conversationId}`,
      text: req.patientTranscript,
      meta: {
        message_id: `${req.conversationId}:${req.turnNumber}`,
        update_id: `${req.conversationId}:${req.turnNumber}`,
        input_modality: "realtime_voice",
        voice_provider: "elevenlabs",
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

    return { reply };
  }
}

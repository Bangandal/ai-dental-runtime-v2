export interface VoiceConfig {
  elevenLabsApiKey: string;
  elevenLabsSpeechEngineId: string;
  runtimeBaseUrl: string;
  runtimeApiKey: string;
  voiceClinicCode: string;
  voicePort: number;
  voiceTtsModelId: string;
  voiceFirstMessage: string;
  voiceFallbackReply: string;
  twilioAuthToken?: string;
  twilioAccountSid?: string;
  voicePublicBaseUrl?: string;
  voiceHumanTransferNumber?: string;
  voiceIdentityHmacSecret?: string;
}

export function readVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const required = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_SPEECH_ENGINE_ID",
    "RUNTIME_BASE_URL",
    "RUNTIME_API_KEY",
    "VOICE_CLINIC_CODE",
  ] as const;

  const missing = required.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`Voice gateway: missing required env vars: ${missing.join(", ")}`);
  }

  const allowInsecureDev = env.VOICE_ALLOW_INSECURE_DEV === "true";
  const securityVars = ["TWILIO_AUTH_TOKEN", "VOICE_PUBLIC_BASE_URL"] as const;
  const missingSecurity = securityVars.filter((k) => !env[k]?.trim());
  if (missingSecurity.length > 0) {
    if (!allowInsecureDev) {
      throw new Error(
        `Voice gateway: missing required security env vars: ${missingSecurity.join(", ")}. ` +
        `Set VOICE_ALLOW_INSECURE_DEV=true to bypass (local dev only, NOT FOR PRODUCTION).`,
      );
    }
    console.warn(
      `\n⚠️  WARNING: VOICE_ALLOW_INSECURE_DEV=true, running without Twilio authentication!` +
      ` Missing: ${missingSecurity.join(", ")}. DO NOT USE IN PRODUCTION.\n`,
    );
  }

  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() || undefined;
  const transferNumber = env.VOICE_HUMAN_TRANSFER_NUMBER?.trim() || undefined;
  const identitySecret = env.VOICE_IDENTITY_HMAC_SECRET?.trim() || undefined;
  const transferSettingsPresent = Boolean(accountSid || transferNumber);
  if (transferSettingsPresent && (!accountSid || !transferNumber || !env.TWILIO_AUTH_TOKEN?.trim())) {
    throw new Error(
      "Voice gateway: live transfer requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and VOICE_HUMAN_TRANSFER_NUMBER together.",
    );
  }
  if (transferNumber && !/^\+[1-9]\d{7,14}$/.test(transferNumber)) {
    throw new Error("Voice gateway: VOICE_HUMAN_TRANSFER_NUMBER must be an E.164 phone number.");
  }
  if (identitySecret && identitySecret.length < 32) {
    throw new Error("Voice gateway: VOICE_IDENTITY_HMAC_SECRET must contain at least 32 characters.");
  }

  return {
    elevenLabsApiKey: env.ELEVENLABS_API_KEY!.trim(),
    elevenLabsSpeechEngineId: env.ELEVENLABS_SPEECH_ENGINE_ID!.trim(),
    runtimeBaseUrl: env.RUNTIME_BASE_URL!.trim().replace(/\/$/, ""),
    runtimeApiKey: env.RUNTIME_API_KEY!.trim(),
    voiceClinicCode: env.VOICE_CLINIC_CODE!.trim(),
    voicePort: env.VOICE_PORT ? parseInt(env.VOICE_PORT, 10) : 3100,
    voiceTtsModelId: env.VOICE_TTS_MODEL_ID?.trim() || "eleven_flash_v2_5",
    voiceFirstMessage:
      env.VOICE_FIRST_MESSAGE?.trim() ||
      "Добрый день. Стоматологическая клиника, чем могу помочь?",
    voiceFallbackReply:
      env.VOICE_FALLBACK_REPLY?.trim() ||
      "Извините, сейчас не удалось обработать запрос. Пожалуйста, повторите ещё раз.",
    twilioAuthToken: env.TWILIO_AUTH_TOKEN?.trim() || undefined,
    twilioAccountSid: accountSid,
    voicePublicBaseUrl: env.VOICE_PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || undefined,
    voiceHumanTransferNumber: transferNumber,
    voiceIdentityHmacSecret: identitySecret,
  };
}

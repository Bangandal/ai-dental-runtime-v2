// Shared channel-agnostic audio transcription service.
// Channel adapters download media bytes; this module validates and transcribes.

export interface InboundAudio {
  channel: "telegram" | "whatsapp";
  message_id: string;
  external_user_id: string;
  mime_type: string;
  filename?: string;
  duration_seconds?: number;
  bytes: Buffer;
}

export interface AudioTranscriptionResult {
  ok: boolean;
  text?: string;
  model?: string;
  error_code?: string;
}

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

const SUPPORTED_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/wav",
  "audio/m4a",
  "video/ogg",
]);

function mimeToExtension(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim() ?? mimeType;
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/m4a": "m4a",
    "video/ogg": "ogg",
  };
  return map[base] ?? "bin";
}

function normalizeMime(raw: string): string {
  // Strip codec suffixes like "audio/ogg; codecs=opus" → "audio/ogg"
  return raw.split(";")[0]?.trim() ?? raw;
}

export async function transcribeAudio(
  audio: InboundAudio,
  openaiApiKey: string,
  model?: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<AudioTranscriptionResult> {
  if (audio.bytes.length > MAX_AUDIO_BYTES) {
    return { ok: false, error_code: "audio_too_large" };
  }

  const normalizedMime = normalizeMime(audio.mime_type);
  if (!SUPPORTED_MIME_TYPES.has(normalizedMime)) {
    return { ok: false, error_code: "unsupported_mime_type" };
  }

  const modelToUse =
    model ??
    process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ??
    DEFAULT_TRANSCRIPTION_MODEL;

  const ext = mimeToExtension(normalizedMime);
  const filename = audio.filename ?? `audio.${ext}`;

  const formData = new FormData();
  formData.append("model", modelToUse);
  formData.append(
    "file",
    new Blob([audio.bytes], { type: normalizedMime }),
    filename,
  );

  let response: Response;
  try {
    response = await fetchFn("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiApiKey}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, error_code: "transcription_timeout" };
    }
    return { ok: false, error_code: "transcription_http_error" };
  }

  if (!response.ok) {
    return { ok: false, error_code: "transcription_http_error" };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error_code: "transcription_http_error" };
  }

  const text =
    typeof (json as Record<string, unknown>)?.text === "string"
      ? ((json as Record<string, unknown>).text as string).trim()
      : "";

  if (!text) {
    return { ok: false, error_code: "empty_transcript" };
  }

  return { ok: true, text, model: modelToUse };
}

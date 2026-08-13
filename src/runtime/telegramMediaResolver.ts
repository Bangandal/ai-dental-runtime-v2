// Telegram-specific channel media resolver.
// Downloads file bytes from Telegram's Bot API using file_id → getFile → download.

import { MAX_AUDIO_BYTES } from "./audioTranscription.ts";

export interface TelegramMediaResolution {
  ok: boolean;
  bytes?: Buffer;
  mime_type?: string;
  filename?: string;
  error_code?: string;
}

export async function resolveTelegramMedia(
  fileId: string,
  botToken: string,
  maxBytes: number = MAX_AUDIO_BYTES,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TelegramMediaResolution> {
  // Step 1: getFile → file_path
  let getFileRes: Response;
  try {
    getFileRes = await fetchFn(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, error_code: "media_download_timeout" };
    }
    return { ok: false, error_code: "media_download_failed" };
  }

  if (!getFileRes.ok) {
    return { ok: false, error_code: "media_download_failed" };
  }

  let getFileJson: unknown;
  try {
    getFileJson = await getFileRes.json();
  } catch {
    return { ok: false, error_code: "media_download_failed" };
  }

  const result = (getFileJson as Record<string, unknown>)?.result as Record<string, unknown> | undefined;
  const filePath = result?.file_path;
  if (typeof filePath !== "string" || !filePath) {
    return { ok: false, error_code: "media_download_failed" };
  }

  const fileSize = typeof result?.file_size === "number" ? result.file_size : null;
  if (fileSize !== null && fileSize > maxBytes) {
    return { ok: false, error_code: "audio_too_large" };
  }

  // Step 2: download bytes
  let downloadRes: Response;
  try {
    downloadRes = await fetchFn(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, error_code: "media_download_timeout" };
    }
    return { ok: false, error_code: "media_download_failed" };
  }

  if (!downloadRes.ok) {
    return { ok: false, error_code: "media_download_failed" };
  }

  let bytes: Buffer;
  try {
    const arrayBuffer = await downloadRes.arrayBuffer();
    bytes = Buffer.from(arrayBuffer);
  } catch {
    return { ok: false, error_code: "media_download_failed" };
  }

  if (bytes.length > maxBytes) {
    return { ok: false, error_code: "audio_too_large" };
  }

  // Derive mime_type and filename from file_path
  const ext = filePath.split(".").pop() ?? "";
  const extToMime: Record<string, string> = {
    ogg: "audio/ogg",
    oga: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/m4a",
    mp4: "audio/mp4",
    webm: "audio/webm",
    wav: "audio/wav",
  };
  const mime_type = extToMime[ext.toLowerCase()] ?? "audio/ogg";
  const filename = filePath.split("/").pop() ?? `audio.${ext}`;

  return { ok: true, bytes, mime_type, filename };
}

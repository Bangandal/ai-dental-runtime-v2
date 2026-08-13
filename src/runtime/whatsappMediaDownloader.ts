// WhatsApp-specific channel media downloader.
// Fetches media bytes from Meta Graph API using media_id → URL → bytes.

import { MAX_AUDIO_BYTES } from "./audioTranscription.ts";

export interface WhatsAppMediaDownloadResult {
  ok: boolean;
  bytes?: Buffer;
  mime_type?: string;
  filename?: string;
  error_code?: string;
}

export async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string,
  maxBytes: number = MAX_AUDIO_BYTES,
  graphApiVersion: string = "v19.0",
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<WhatsAppMediaDownloadResult> {
  // Step 1: get media URL from Graph API
  let metaRes: Response;
  try {
    metaRes = await fetchFn(
      `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(mediaId)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, error_code: "media_download_timeout" };
    }
    return { ok: false, error_code: "media_download_failed" };
  }

  if (!metaRes.ok) {
    return { ok: false, error_code: "media_download_failed" };
  }

  let metaJson: unknown;
  try {
    metaJson = await metaRes.json();
  } catch {
    return { ok: false, error_code: "media_download_failed" };
  }

  const mediaUrl = (metaJson as Record<string, unknown>)?.url;
  if (typeof mediaUrl !== "string" || !mediaUrl) {
    return { ok: false, error_code: "media_download_failed" };
  }

  const fileSize = (metaJson as Record<string, unknown>)?.file_size;
  if (typeof fileSize === "number" && fileSize > maxBytes) {
    return { ok: false, error_code: "audio_too_large" };
  }

  const mimeFromMeta = (metaJson as Record<string, unknown>)?.mime_type;

  // Step 2: download bytes from media URL
  let downloadRes: Response;
  try {
    downloadRes = await fetchFn(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
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

  const mime_type =
    typeof mimeFromMeta === "string" ? mimeFromMeta.split(";")[0]?.trim() ?? "audio/ogg" : "audio/ogg";

  return { ok: true, bytes, mime_type, filename: `audio_${mediaId}.ogg` };
}

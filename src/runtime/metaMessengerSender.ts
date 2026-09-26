export const DEFAULT_META_MESSENGER_SEND_TIMEOUT_MS = 10_000;

export interface MetaMessengerSendResult {
  ok: boolean;
  messageId?: string;
  recipientId?: string;
  error?: string;
}

export async function sendMetaMessengerMessage(opts: {
  pageAccessToken: string;
  pageId: string;
  graphApiVersion: string;
  recipientId: string;
  text: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<MetaMessengerSendResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_META_MESSENGER_SEND_TIMEOUT_MS;
  const url = `https://graph.facebook.com/${opts.graphApiVersion}/${opts.pageId}/messages`;

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Never log or surface the Page access token.
        Authorization: `Bearer ${opts.pageAccessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: opts.recipientId },
        messaging_type: "RESPONSE",
        message: { text: opts.text },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const json = await response.json().catch(() => null) as
      | { message_id?: unknown; recipient_id?: unknown }
      | null;

    return {
      ok: true,
      messageId: typeof json?.message_id === "string" ? json.message_id : undefined,
      recipientId: typeof json?.recipient_id === "string" ? json.recipient_id : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

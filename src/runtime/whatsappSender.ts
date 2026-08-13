export const DEFAULT_WHATSAPP_SEND_TIMEOUT_MS = 10_000;

export interface WhatsAppSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendWhatsAppMessage(opts: {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  to: string;
  text: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<WhatsAppSendResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WHATSAPP_SEND_TIMEOUT_MS;

  const url = `https://graph.facebook.com/${opts.graphApiVersion}/${opts.phoneNumberId}/messages`;
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to: opts.to,
    type: "text",
    text: { body: opts.text },
  });

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Never log this value
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const messageId =
      typeof (json?.messages as unknown as Array<{ id?: string }>)?.[0]?.id === "string"
        ? (json!.messages as Array<{ id?: string }>)[0].id
        : undefined;

    return { ok: true, messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

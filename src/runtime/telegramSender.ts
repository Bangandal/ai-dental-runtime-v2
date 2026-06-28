export async function sendTelegramMessage(opts: {
  botToken: string;
  chatId: string;
  text: string;
  fetch?: typeof globalThis.fetch;
}): Promise<{ ok: boolean; error?: string }> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  try {
    const response = await fetchFn(
      `https://api.telegram.org/bot${opts.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: opts.chatId, text: opts.text }),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `telegram_api_error:${response.status}:${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

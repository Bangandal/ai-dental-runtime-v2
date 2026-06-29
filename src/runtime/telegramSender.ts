export interface TelegramReplyMarkup {
  keyboard: Array<Array<{ text: string; request_contact?: boolean }>>;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
}

export function buildContactRequestReplyMarkup(buttonText = "📞 Поделиться номером"): TelegramReplyMarkup {
  return {
    keyboard: [[{ text: buttonText, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

export async function sendTelegramMessage(opts: {
  botToken: string;
  chatId: string;
  text: string;
  replyMarkup?: TelegramReplyMarkup;
  fetch?: typeof globalThis.fetch;
}): Promise<{ ok: boolean; error?: string }> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const body: Record<string, unknown> = { chat_id: opts.chatId, text: opts.text };
  if (opts.replyMarkup !== undefined) {
    body.reply_markup = opts.replyMarkup;
  }
  try {
    const response = await fetchFn(
      `https://api.telegram.org/bot${opts.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      return { ok: false, error: `telegram_api_error:${response.status}:${responseBody.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

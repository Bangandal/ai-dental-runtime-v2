export interface TelegramReplyMarkup {
  keyboard?: Array<Array<{ text: string; request_contact?: boolean }>>;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  remove_keyboard?: true;
}

export function buildRemoveKeyboardMarkup(): TelegramReplyMarkup {
  return { remove_keyboard: true };
}

export function buildContactRequestReplyMarkup(buttonText = "📞 Поделиться номером"): TelegramReplyMarkup {
  return {
    keyboard: [[{ text: buttonText, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

// Upper bound for a single Telegram sendMessage request. Without it a hung
// Telegram API call keeps the webhook handler (and the runtime turn) waiting.
export const DEFAULT_TELEGRAM_SEND_TIMEOUT_MS = 10_000;

export interface TelegramDeliveryOutcome {
  ok: boolean;
  retry_count: number;
  error_code?: string;
  error?: string;
}

// Backoff between first attempt and single retry.
export const TELEGRAM_RETRY_BACKOFF_MS = 250;

export async function sendTelegramMessage(opts: {
  botToken: string;
  chatId: string;
  text: string;
  messageThreadId?: string | null;
  replyMarkup?: TelegramReplyMarkup;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TELEGRAM_SEND_TIMEOUT_MS;
  const body: Record<string, unknown> = { chat_id: opts.chatId, text: opts.text };
  if (opts.messageThreadId !== undefined && opts.messageThreadId !== null && opts.messageThreadId.trim().length > 0) {
    const trimmedThreadId = opts.messageThreadId.trim();
    body.message_thread_id = /^\d+$/.test(trimmedThreadId) ? Number(trimmedThreadId) : trimmedThreadId;
  }
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
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      return { ok: false, error: `telegram_api_error:${response.status}:${responseBody.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, error: `telegram_timeout:${timeoutMs}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Wraps sendTelegramMessage with a single retry on non-timeout failure.
// Never throws — all outcomes are encoded in TelegramDeliveryOutcome.
export async function sendTelegramMessageWithRetry(
  opts: Parameters<typeof sendTelegramMessage>[0] & { retryBackoffMs?: number },
): Promise<TelegramDeliveryOutcome> {
  const backoffMs = opts.retryBackoffMs ?? TELEGRAM_RETRY_BACKOFF_MS;
  const first = await sendTelegramMessage(opts);
  if (first.ok) {
    return { ok: true, retry_count: 0 };
  }
  if (first.error?.startsWith("telegram_timeout:")) {
    return { ok: false, retry_count: 0, error_code: "telegram_timeout", error: first.error };
  }
  await new Promise<void>((r) => setTimeout(r, backoffMs));
  const second = await sendTelegramMessage(opts);
  if (second.ok) {
    return { ok: true, retry_count: 1 };
  }
  const errorCode = second.error?.startsWith("telegram_timeout:") ? "telegram_timeout" : "telegram_send_failed";
  return { ok: false, retry_count: 1, error_code: errorCode, error: second.error?.slice(0, 300) };
}

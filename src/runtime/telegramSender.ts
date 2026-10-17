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

export async function sendChatAction(opts: {
  botToken: string;
  chatId: string;
  action?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  try {
    await fetchFn(
      `https://api.telegram.org/bot${opts.botToken}/sendChatAction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: opts.chatId, action: opts.action ?? "typing" }),
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    // typing indicator failure is non-critical — swallow
  }
}

export function splitReplyText(text: string, maxParts = 3): string[] {
  if (text.length <= 200) return [text];
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return [text];
  if (paragraphs.length <= maxParts) return paragraphs;
  // Merge overflow into last part
  const parts = paragraphs.slice(0, maxParts - 1);
  parts.push(paragraphs.slice(maxParts - 1).join("\n\n"));
  return parts;
}

export async function sendTelegramReplyWithSplitting(opts: {
  botToken: string;
  chatId: string;
  text: string;
  messageThreadId?: string | null;
  replyMarkup?: TelegramReplyMarkup;
  fetch?: typeof globalThis.fetch;
  retryBackoffMs?: number;
  splitDelayMs?: number;
}): Promise<TelegramDeliveryOutcome> {
  const parts = splitReplyText(opts.text);
  let finalOutcome: TelegramDeliveryOutcome = { ok: true, retry_count: 0 };

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      await new Promise<void>((r) => setTimeout(r, opts.splitDelayMs ?? 500));
    }
    const isLast = i === parts.length - 1;
    const outcome = await sendTelegramMessageWithRetry({
      botToken: opts.botToken,
      chatId: opts.chatId,
      text: parts[i],
      messageThreadId: opts.messageThreadId,
      replyMarkup: isLast ? opts.replyMarkup : undefined,
      fetch: opts.fetch,
      retryBackoffMs: opts.retryBackoffMs,
    });
    if (!outcome.ok) {
      finalOutcome = outcome;
      break;
    }
    finalOutcome = outcome;
  }

  return finalOutcome;
}

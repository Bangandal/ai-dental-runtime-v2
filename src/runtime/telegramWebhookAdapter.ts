import { timingSafeEqual } from "node:crypto";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramFrom;
  text?: string;
}

export interface TelegramFrom {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramTurnBody {
  clinic_code: string;
  channel: "telegram";
  external_user_id: string;
  chat_id: string;
  text: string;
  meta: {
    update_id: string;
    message_id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    telegram_chat_type: string;
  };
}

export type TelegramSecretResult =
  | { ok: true }
  | { ok: false; code: "unconfigured" | "unauthorized" };

export function checkTelegramWebhookSecret(opts: {
  configuredSecret: string | undefined;
  requestSecret: string | undefined;
  isProduction: boolean;
}): TelegramSecretResult {
  const { configuredSecret, requestSecret, isProduction } = opts;
  if (!configuredSecret) {
    return isProduction ? { ok: false, code: "unconfigured" } : { ok: true };
  }
  if (!requestSecret) return { ok: false, code: "unauthorized" };
  try {
    const a = Buffer.from(configuredSecret, "utf8");
    const b = Buffer.from(requestSecret, "utf8");
    if (a.length !== b.length) return { ok: false, code: "unauthorized" };
    if (!timingSafeEqual(a, b)) return { ok: false, code: "unauthorized" };
  } catch {
    return { ok: false, code: "unauthorized" };
  }
  return { ok: true };
}

export type TelegramNormalizeResult =
  | { ok: true; body: TelegramTurnBody }
  | { ok: false; reason: "no_message" | "no_text" | "edited_message" | "no_from" };

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  clinicCode: string,
): TelegramNormalizeResult {
  if (update.edited_message !== undefined) {
    return { ok: false, reason: "edited_message" };
  }
  const message = update.message;
  if (!message) {
    return { ok: false, reason: "no_message" };
  }
  if (!message.text?.trim()) {
    return { ok: false, reason: "no_text" };
  }
  const from = message.from;
  if (!from) {
    return { ok: false, reason: "no_from" };
  }
  return {
    ok: true,
    body: {
      clinic_code: clinicCode,
      channel: "telegram",
      external_user_id: String(from.id),
      chat_id: String(message.chat.id),
      text: message.text.trim(),
      meta: {
        update_id: String(update.update_id),
        message_id: String(message.message_id),
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        last_name: from.last_name ?? null,
        telegram_chat_type: message.chat.type,
      },
    },
  };
}

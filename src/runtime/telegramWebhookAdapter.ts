import { timingSafeEqual } from "node:crypto";

export interface TelegramContact {
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  user_id?: number;
}

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
  contact?: TelegramContact;
}

export interface TelegramFrom {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramContactCapture {
  phone_number: string;
  phone_source: "telegram_contact_button";
  phone_consent: true;
  phone_collected_at: string;
  telegram_contact: {
    phone_number: string;
    first_name?: string;
    last_name?: string;
    user_id?: number;
  };
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
  | { ok: true; type: "text"; body: TelegramTurnBody }
  | { ok: true; type: "contact"; capture: TelegramContactCapture; chat_id: string; external_user_id: string; update_id: string; message_id: string; clinic_code: string }
  | { ok: true; type: "contact_foreign"; chat_id: string; external_user_id: string; message_id: string; clinic_code: string }
  | { ok: false; reason: "no_message" | "no_text" | "no_contact_phone" | "edited_message" | "no_from" };

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  clinicCode: string,
  now?: Date,
): TelegramNormalizeResult {
  if (update.edited_message !== undefined) {
    return { ok: false, reason: "edited_message" };
  }
  const message = update.message;
  if (!message) {
    return { ok: false, reason: "no_message" };
  }
  const from = message.from;
  if (!from) {
    return { ok: false, reason: "no_from" };
  }

  // Contact update — patient shared phone via contact button
  if (message.contact !== undefined) {
    const phone = message.contact.phone_number;
    if (!phone) {
      return { ok: false, reason: "no_contact_phone" };
    }
    // Ownership check: if contact.user_id is present it must match the sender.
    // Prevents storing a third-party phone as if it belonged to the current user.
    const contactUserId = message.contact.user_id;
    if (contactUserId !== undefined && contactUserId !== from.id) {
      return {
        ok: true,
        type: "contact_foreign",
        chat_id: String(message.chat.id),
        external_user_id: String(from.id),
        message_id: String(message.message_id),
        clinic_code: clinicCode,
      };
    }
    const capture: TelegramContactCapture = {
      phone_number: phone,
      phone_source: "telegram_contact_button",
      phone_consent: true,
      phone_collected_at: (now ?? new Date()).toISOString(),
      telegram_contact: {
        phone_number: phone,
        first_name: message.contact.first_name,
        last_name: message.contact.last_name,
        user_id: message.contact.user_id,
      },
    };
    return {
      ok: true,
      type: "contact",
      capture,
      chat_id: String(message.chat.id),
      external_user_id: String(from.id),
      update_id: String(update.update_id),
      message_id: String(message.message_id),
      clinic_code: clinicCode,
    };
  }

  // Text update
  if (!message.text?.trim()) {
    return { ok: false, reason: "no_text" };
  }
  return {
    ok: true,
    type: "text",
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

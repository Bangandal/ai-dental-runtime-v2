import { createHmac, timingSafeEqual } from "node:crypto";
import type { RuntimeTurnHttpRequestBody } from "./runtimeTurnHttpRoute.ts";

export interface MetaMessengerWebhookPayload {
  object?: string;
  entry?: MetaMessengerEntry[];
}

export interface MetaMessengerEntry {
  id?: string;
  time?: number;
  messaging?: MetaMessengerEvent[];
}

export interface MetaMessengerEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
  };
}

export interface MetaMessengerTurn {
  runtimeBody: RuntimeTurnHttpRequestBody;
  senderId: string;
  messageId: string;
}

export type MetaMessengerNormalizeResult =
  | { ok: true; turns: MetaMessengerTurn[] }
  | { ok: false; reason: "malformed" | "not_page_object" };

export type MetaWebhookSignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "invalid_signature" };

export function verifyMetaWebhookSignature(opts: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  appSecret: string;
}): MetaWebhookSignatureResult {
  const header = opts.signatureHeader;
  if (!header) return { ok: false, reason: "missing_header" };

  const prefix = "sha256=";
  if (!header.startsWith(prefix)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const receivedHex = header.slice(prefix.length);
  const expectedHex = createHmac("sha256", opts.appSecret)
    .update(opts.rawBody)
    .digest("hex");

  try {
    const expected = Buffer.from(expectedHex, "hex");
    const received = Buffer.from(receivedHex, "hex");
    if (expected.length !== received.length) {
      return { ok: false, reason: "invalid_signature" };
    }
    if (!timingSafeEqual(expected, received)) {
      return { ok: false, reason: "invalid_signature" };
    }
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true };
}

export function normalizeMetaMessengerPayload(
  payload: unknown,
  clinicCode: string,
  configuredPageId?: string,
): MetaMessengerNormalizeResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "malformed" };
  }

  const webhook = payload as MetaMessengerWebhookPayload;
  if (webhook.object !== "page") {
    return { ok: false, reason: "not_page_object" };
  }

  const turns: MetaMessengerTurn[] = [];
  const entries = Array.isArray(webhook.entry) ? webhook.entry : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    const entryPageId = typeof entry.id === "string" ? entry.id : null;
    if (configuredPageId && entryPageId && entryPageId !== configuredPageId) {
      continue;
    }

    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      if (!event || typeof event !== "object") continue;

      const message = event.message;
      if (!message || message.is_echo === true) continue;

      const senderId = event.sender?.id;
      const recipientId = event.recipient?.id;
      const messageId = message.mid;
      const text = message.text?.trim();

      if (!senderId || !messageId || !text) continue;

      // A Page echo is already filtered above. For inbound user messages the
      // sender is the user's Page-scoped ID (PSID), which is the stable transport
      // identity used by Runtime for contact/dedupe isolation.
      const runtimeBody: RuntimeTurnHttpRequestBody = {
        clinic_code: clinicCode,
        channel: "messenger",
        external_user_id: senderId,
        chat_id: senderId,
        text,
        meta: {
          message_id: messageId,
          page_id: entryPageId ?? configuredPageId ?? null,
          recipient_id: recipientId ?? null,
          timestamp: typeof event.timestamp === "number" ? String(event.timestamp) : null,
          source: "meta_messenger",
        },
      };

      turns.push({ runtimeBody, senderId, messageId });
    }
  }

  return { ok: true, turns };
}

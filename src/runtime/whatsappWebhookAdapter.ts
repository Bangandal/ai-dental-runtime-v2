import { createHmac, timingSafeEqual } from "node:crypto";
import type { RuntimeTurnHttpRequestBody } from "./runtimeTurnHttpRoute.ts";

// ── WhatsApp Cloud API webhook payload types ──────────────────────────────────

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id?: string;
  changes?: WhatsAppChange[];
}

export interface WhatsAppChange {
  value?: WhatsAppChangeValue;
  field?: string;
}

export interface WhatsAppChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: unknown[];
}

export interface WhatsAppContact {
  profile?: { name?: string };
  wa_id?: string;
}

export interface WhatsAppMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
}

// ── Normalized result types ───────────────────────────────────────────────────

export type WhatsAppNormalizeResult =
  | { ok: true; turns: WhatsAppTurn[] }
  | { ok: false; reason: "not_whatsapp_object" | "no_entries" | "malformed" };

export interface WhatsAppTurn {
  runtimeBody: RuntimeTurnHttpRequestBody;
  waId: string;
}

// ── Signature verification ────────────────────────────────────────────────────

export type WhatsAppSigResult =
  | { ok: true }
  | { ok: false; reason: "missing_secret" | "missing_header" | "invalid_signature" };

export function verifyWhatsAppSignature(opts: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  appSecret: string;
}): WhatsAppSigResult {
  const { rawBody, signatureHeader, appSecret } = opts;
  if (!signatureHeader) return { ok: false, reason: "missing_header" };

  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return { ok: false, reason: "invalid_signature" };
  const receivedHex = signatureHeader.slice(prefix.length);

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(receivedHex, "hex");
    if (a.length !== b.length) return { ok: false, reason: "invalid_signature" };
    if (!timingSafeEqual(a, b)) return { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}

// ── Phone normalization ───────────────────────────────────────────────────────

export function normalizeWhatsAppPhone(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  return digits ? `+${digits}` : waId;
}

// ── Payload normalization ─────────────────────────────────────────────────────

export function normalizeWhatsAppPayload(
  payload: unknown,
  clinicId: string,
): WhatsAppNormalizeResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "malformed" };
  }

  const p = payload as WhatsAppWebhookPayload;

  if (p.object !== "whatsapp_business_account") {
    return { ok: false, reason: "not_whatsapp_object" };
  }

  if (!Array.isArray(p.entry) || p.entry.length === 0) {
    return { ok: true, turns: [] };
  }

  const turns: WhatsAppTurn[] = [];

  for (const entry of p.entry) {
    if (!Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const value = change.value;
      if (!value) continue;

      const messages = value.messages;
      if (!Array.isArray(messages) || messages.length === 0) continue;

      for (const message of messages) {
        if (!message || typeof message !== "object") continue;

        // Only process text messages — skip all other types silently
        if (message.type !== "text") continue;

        const body = message.text?.body?.trim();
        if (!body) continue;

        const waId = message.from;
        if (!waId || typeof waId !== "string") continue;

        const messageId = message.id;
        if (!messageId || typeof messageId !== "string") continue;

        const phone = normalizeWhatsAppPhone(waId);

        const runtimeBody: RuntimeTurnHttpRequestBody = {
          clinic_code: clinicId,
          channel: "whatsapp",
          // wa_id is platform-derived — never derived from message text
          external_user_id: waId,
          chat_id: waId,
          text: body,
          meta: {
            message_id: messageId,
            wa_id: waId,
            phone_number: phone,
            phone_source: "whatsapp_sender",
            timestamp: message.timestamp ?? null,
          },
        };

        turns.push({ runtimeBody, waId });
      }
    }
  }

  return { ok: true, turns };
}

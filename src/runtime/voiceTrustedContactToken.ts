import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export interface VoiceTrustedContactTokenContext {
  clinicCode: string;
  conversationId: string;
  callSid: string;
  messageId: string;
}

function deriveKey(runtimeApiKey: string): Buffer {
  return createHash("sha256")
    .update("ai-dental-runtime:voice-trusted-contact:v1\0", "utf8")
    .update(runtimeApiKey, "utf8")
    .digest();
}

function buildAad(context: VoiceTrustedContactTokenContext): Buffer {
  return Buffer.from([
    VERSION,
    context.clinicCode,
    context.conversationId,
    context.callSid,
    context.messageId,
  ].join("\n"), "utf8");
}

function hasValidContext(context: VoiceTrustedContactTokenContext): boolean {
  return Boolean(
    context.clinicCode.trim()
    && context.conversationId.trim()
    && context.callSid.trim()
    && context.messageId.trim(),
  );
}

/**
 * Protect the raw Twilio caller id before it crosses the internal HTTP boundary.
 * The token is confidential and authenticated (AES-256-GCM), and is bound to the
 * exact clinic/conversation/call/message so it cannot be transplanted to another turn.
 */
export function createVoiceTrustedContactToken(input: {
  runtimeApiKey: string;
  phoneNumber: string;
  context: VoiceTrustedContactTokenContext;
}): string | null {
  const secret = input.runtimeApiKey.trim();
  const phoneNumber = input.phoneNumber.trim();
  if (!secret || !E164_PHONE.test(phoneNumber) || !hasValidContext(input.context)) return null;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  cipher.setAAD(buildAad(input.context));
  const ciphertext = Buffer.concat([
    cipher.update(phoneNumber, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * Return the trusted E.164 caller id only when authentication, context binding and
 * decryption all succeed. Invalid/tampered tokens fail closed to null.
 */
export function readVoiceTrustedContactToken(input: {
  runtimeApiKey: string;
  token: unknown;
  context: VoiceTrustedContactTokenContext;
}): string | null {
  const secret = input.runtimeApiKey.trim();
  if (!secret || typeof input.token !== "string" || !hasValidContext(input.context)) return null;

  const parts = input.token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const ciphertext = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES || ciphertext.length === 0 || tag.length !== 16) return null;

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAAD(buildAad(input.context));
    decipher.setAuthTag(tag);
    const phoneNumber = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");

    return E164_PHONE.test(phoneNumber) ? phoneNumber : null;
  } catch {
    return null;
  }
}

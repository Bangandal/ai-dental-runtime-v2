import type { AgentUiActions } from "./openaiRuntimeAgent.ts";

export type SupportedChannel = "telegram" | "whatsapp" | "web" | "sms" | "unknown";

export type PhoneCaptureMethod =
  | "telegram_contact_button"
  | "sender_phone"
  | "web_form"
  | "manual_fallback"
  | "none";

export interface ChannelCapabilityPolicy {
  channel: SupportedChannel;
  supports_trusted_phone_capture: boolean;
  trusted_phone_sources: string[];
  phone_capture_method: PhoneCaptureMethod;
}

export function getChannelCapabilityPolicy(channel: string | null | undefined): ChannelCapabilityPolicy {
  switch (channel) {
    case "telegram":
      return {
        channel: "telegram",
        supports_trusted_phone_capture: true,
        trusted_phone_sources: ["telegram_contact_button"],
        phone_capture_method: "telegram_contact_button",
      };
    case "whatsapp":
      return {
        channel: "whatsapp",
        supports_trusted_phone_capture: true,
        trusted_phone_sources: ["whatsapp_sender"],
        phone_capture_method: "sender_phone",
      };
    case "web":
      return {
        channel: "web",
        supports_trusted_phone_capture: true,
        trusted_phone_sources: ["web_form"],
        phone_capture_method: "web_form",
      };
    case "sms":
      return {
        channel: "sms",
        supports_trusted_phone_capture: false,
        trusted_phone_sources: [],
        phone_capture_method: "manual_fallback",
      };
    default:
      return {
        channel: "unknown",
        supports_trusted_phone_capture: false,
        trusted_phone_sources: [],
        phone_capture_method: "none",
      };
  }
}

/**
 * Strips model-emitted Telegram contact UI for channels where the Telegram
 * contact button is not permitted. Preserves all unrelated UI fields.
 * Must be applied to every final_response path before returning to the caller.
 */
export function sanitizePhoneCaptureUiForChannel(
  ui: AgentUiActions | undefined,
  channel: string | null | undefined,
): AgentUiActions | undefined {
  if (!ui) return ui;
  const policy = getChannelCapabilityPolicy(channel);
  if (policy.phone_capture_method === "telegram_contact_button") {
    // Telegram: contact button permitted — pass through unchanged
    return ui;
  }
  // Non-Telegram: strip Telegram-specific contact request fields
  if (!ui.telegram) return ui;
  const { request_contact: _rc, button_text: _bt, ...restTelegram } = ui.telegram;
  const hasRemainingTelegram = Object.keys(restTelegram).length > 0;
  const { telegram: _tg, ...restUi } = ui;
  return hasRemainingTelegram
    ? { ...restUi, telegram: restTelegram }
    : Object.keys(restUi).length > 0 ? restUi : undefined;
}

/**
 * Builds channel-appropriate contact capture UI for the phone request step.
 * Returns undefined for channels that handle phone capture natively or not at all —
 * only Telegram requires an explicit contact button injected by the runtime.
 */
export function buildPhoneCaptureUi(
  channel: string | null | undefined,
  _locale?: string | null,
): AgentUiActions | undefined {
  const policy = getChannelCapabilityPolicy(channel);
  if (policy.phone_capture_method === "telegram_contact_button") {
    return {
      telegram: {
        request_contact: true,
        button_text: "📞 Поделиться контактом",
      },
    };
  }
  return undefined;
}

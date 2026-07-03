import type { RuntimeAgentToolRequest, RuntimeAgentToolResult, ChannelContact } from "./openaiRuntimeAgent.ts";
import { TRUSTED_PHONE_SOURCES } from "../integrations/cliniccard/bookingApplyExecutor.ts";

export function hasTrustedPhone(channelContact: ChannelContact | undefined): boolean {
  return channelContact !== undefined && TRUSTED_PHONE_SOURCES.has(channelContact.phone_source);
}

export function hasBookingApplyPending(toolRequests: RuntimeAgentToolRequest[]): boolean {
  return toolRequests.some((r) => r.tool === "booking.apply");
}

export function hasAvailabilitySuccessWithSlots(toolResults: RuntimeAgentToolResult[]): boolean {
  return toolResults.some((r) => {
    if (r.tool !== "availability.check" || r.status !== "success") return false;
    const data = r.data as { slots?: unknown[] } | null | undefined;
    return Array.isArray(data?.slots) && data.slots.length > 0;
  });
}

/**
 * Returns true when round-2 is about to request booking.apply but trusted phone is missing.
 * Caller should intercept before forced_finalization and ask for phone via contact button.
 *
 * Conditions (all required):
 *   - booking.apply appears in the pending round-2 tool requests
 *   - round-1 availability.check succeeded with ≥1 slot (confirms date/time are resolved)
 *   - channel_contact is absent or phone_source is not in TRUSTED_PHONE_SOURCES
 */
export function shouldInterceptForContactButton(params: {
  pendingToolRequests: RuntimeAgentToolRequest[];
  completedToolResults: RuntimeAgentToolResult[];
  channelContact: ChannelContact | undefined;
}): boolean {
  return (
    hasBookingApplyPending(params.pendingToolRequests) &&
    hasAvailabilitySuccessWithSlots(params.completedToolResults) &&
    !hasTrustedPhone(params.channelContact)
  );
}

const CONTACT_BUTTON_PROMPTS: Record<string, string> = {
  ru: "Пожалуйста, поделитесь вашим номером телефона для подтверждения записи.",
  cs: "Prosím, sdílejte své telefonní číslo pro potvrzení rezervace.",
  en: "Please share your phone number to confirm the booking.",
};

const CONTACT_BUTTON_LABELS: Record<string, string> = {
  ru: "Поделиться номером",
  cs: "Sdílet číslo",
  en: "Share phone number",
};

function resolveLocaleKey(locale?: string | null): "ru" | "cs" | "en" {
  const n = String(locale ?? "").toLowerCase();
  if (n.startsWith("cs")) return "cs";
  if (n.startsWith("en")) return "en";
  return "ru";
}

export function buildContactButtonReply(locale?: string | null): {
  final_patient_reply: string;
  ui: { telegram: { request_contact: true; button_text: string } };
} {
  const lang = resolveLocaleKey(locale);
  return {
    final_patient_reply: CONTACT_BUTTON_PROMPTS[lang],
    ui: {
      telegram: {
        request_contact: true,
        button_text: CONTACT_BUTTON_LABELS[lang],
      },
    },
  };
}

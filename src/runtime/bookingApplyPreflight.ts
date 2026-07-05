import type { RuntimeAgentToolRequest, RuntimeAgentToolResult, ChannelContact } from "./openaiRuntimeAgent.ts";
import { hasTrustedPhone, hasBookingApplyPending } from "./bookingContactGuard.ts";

export function hasAvailabilitySuccessWithNoSlots(toolResults: RuntimeAgentToolResult[]): boolean {
  return toolResults.some((r) => {
    if (r.tool !== "availability.check" || r.status !== "success") return false;
    const data = r.data as { slots?: unknown[] } | null | undefined;
    return Array.isArray(data?.slots) && data.slots.length === 0;
  });
}

/**
 * Returns true when round-2 requests booking.apply but trusted phone is absent.
 * Fires regardless of whether availability.check returned slots.
 */
export function shouldInterceptMissingPhoneBeforeBookingApply(params: {
  pendingToolRequests: RuntimeAgentToolRequest[];
  channelContact: ChannelContact | undefined;
}): boolean {
  return (
    hasBookingApplyPending(params.pendingToolRequests) &&
    !hasTrustedPhone(params.channelContact)
  );
}

/**
 * Returns true when round-2 requests booking.apply, trusted phone is present,
 * but availability.check returned 0 slots.  The model must not execute booking.apply
 * against a slot that does not exist.
 */
export function shouldInterceptNoSlotsBeforeBookingApply(params: {
  pendingToolRequests: RuntimeAgentToolRequest[];
  completedToolResults: RuntimeAgentToolResult[];
  channelContact: ChannelContact | undefined;
}): boolean {
  return (
    hasBookingApplyPending(params.pendingToolRequests) &&
    hasTrustedPhone(params.channelContact) &&
    hasAvailabilitySuccessWithNoSlots(params.completedToolResults)
  );
}

const NO_SLOTS_REPLIES: Record<string, string> = {
  ru: "К сожалению, на выбранное время нет свободных слотов. Уточните, пожалуйста, другое время или дату.",
  cs: "Bohužel, na vybraný čas nejsou volné sloty. Zkuste prosím jiný čas nebo datum.",
  en: "Unfortunately, there are no available slots for the selected time. Please choose a different time or date.",
};

function resolveLocaleKey(locale?: string | null): "ru" | "cs" | "en" {
  const n = String(locale ?? "").toLowerCase();
  if (n.startsWith("cs")) return "cs";
  if (n.startsWith("en")) return "en";
  return "ru";
}

export function buildNoSlotsPreflightReply(locale?: string | null): string {
  return NO_SLOTS_REPLIES[resolveLocaleKey(locale)];
}

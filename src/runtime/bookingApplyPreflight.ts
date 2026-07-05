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

// ── Round-1 missing-slot guard ────────────────────────────────────────────────

/**
 * Returns true when booking.apply args don't include both requested_date AND
 * requested_time.  Used in round-1 preflight to block the executor from being
 * called without a concrete confirmed slot.
 */
export function bookingApplyArgsMissingSlot(args: Record<string, unknown>): boolean {
  return (
    typeof args.requested_date !== "string" ||
    !args.requested_date.trim() ||
    typeof args.requested_time !== "string" ||
    !args.requested_time.trim()
  );
}

const MISSING_SLOT_REPLIES: Record<string, string> = {
  ru: "Пожалуйста, выберите конкретную дату и время для записи. Могу проверить доступные слоты — на какую дату удобно?",
  cs: "Prosím, vyberte konkrétní datum a čas pro rezervaci. Mohu zkontrolovat dostupné termíny — jaký datum vám vyhovuje?",
  en: "Please choose a specific date and time for the appointment. I can check available slots — what date works for you?",
};

export function buildMissingSlotReply(locale?: string | null): string {
  return MISSING_SLOT_REPLIES[resolveLocaleKey(locale)];
}

// ── Missing name fields guard ─────────────────────────────────────────────────

/**
 * Returns the list of required name fields (first_name, last_name) missing from
 * booking.apply args.  Empty list means all name fields are present.
 */
export function getMissingBookingApplyNameFields(args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (typeof args.first_name !== "string" || !args.first_name.trim()) missing.push("first_name");
  if (typeof args.last_name !== "string" || !args.last_name.trim()) missing.push("last_name");
  return missing;
}

export function buildMissingNameFieldsReply(missingFields: string[], locale?: string | null): string {
  const key = resolveLocaleKey(locale);
  const hasFirst = missingFields.includes("first_name");
  const hasLast = missingFields.includes("last_name");

  if (key === "en") {
    if (hasFirst && hasLast) return "To book your appointment, please share your first and last name.";
    if (hasFirst) return "What is your first name?";
    return "What is your last name?";
  }
  if (key === "cs") {
    if (hasFirst && hasLast) return "Pro rezervaci prosím uveďte jméno a příjmení.";
    if (hasFirst) return "Jak se jmenujete? (jméno)";
    return "Jak se jmenujete? (příjmení)";
  }
  if (hasFirst && hasLast) return "Для записи укажите ваше имя и фамилию.";
  if (hasFirst) return "Как вас зовут? Укажите имя.";
  return "Укажите, пожалуйста, вашу фамилию.";
}

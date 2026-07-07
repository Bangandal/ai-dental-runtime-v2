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
 * Returns true when booking.apply is pending and availability.check returned 0 slots.
 * Fires regardless of phone trust — no-slots intercept takes priority over the phone
 * contact button because there is no slot to confirm even if the phone were present.
 */
export function shouldInterceptNoSlotsBeforeBookingApply(params: {
  pendingToolRequests: RuntimeAgentToolRequest[];
  completedToolResults: RuntimeAgentToolResult[];
}): boolean {
  return (
    hasBookingApplyPending(params.pendingToolRequests) &&
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

// ── Missing slot date/time guard ──────────────────────────────────────────────

/**
 * Returns true when booking.apply args don't include both requested_date AND
 * requested_time.
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

// ── Missing service guard ─────────────────────────────────────────────────────

/**
 * Returns true when booking.apply args contain neither service nor service_reason.
 */
export function bookingApplyArgsMissingService(args: Record<string, unknown>): boolean {
  return (
    (typeof args.service !== "string" || !args.service.trim()) &&
    (typeof args.service_reason !== "string" || !args.service_reason.trim())
  );
}

const MISSING_SERVICE_REPLIES: Record<string, string> = {
  ru: "Уточните, пожалуйста, причину визита или нужную услугу.",
  cs: "Upřesněte prosím důvod návštěvy nebo požadovanou službu.",
  en: "Please specify the reason for your visit or the service you need.",
};

export function buildMissingServiceReply(locale?: string | null): string {
  return MISSING_SERVICE_REPLIES[resolveLocaleKey(locale)];
}

// ── Slot validity check ───────────────────────────────────────────────────────

// Same regex as availabilityPresentationTruth.ts — keep in sync.
function extractHHMM(startsAt: string): string | null {
  const match = startsAt.match(/T(\d{2}:\d{2})(?::\d{2})?/);
  return match ? match[1] : null;
}

/**
 * Returns true when booking.apply requested date+time doesn't match any slot from
 * availability.check results. Validates full date+time (not just time) to prevent
 * cross-date booking when the same time exists on a different date.
 * Only fires when availability returned ≥1 slot — the 0-slot case is handled by
 * shouldInterceptNoSlotsBeforeBookingApply upstream.
 */
export function shouldInterceptInvalidSlotDateTime(params: {
  pendingToolRequests: RuntimeAgentToolRequest[];
  completedToolResults: RuntimeAgentToolResult[];
}): boolean {
  if (!hasBookingApplyPending(params.pendingToolRequests)) return false;

  const req = params.pendingToolRequests.find((r) => r.tool === "booking.apply");
  if (!req) return false;
  const requestedDate =
    typeof req.arguments.requested_date === "string" ? req.arguments.requested_date.trim() : null;
  const requestedTime =
    typeof req.arguments.requested_time === "string" ? req.arguments.requested_time.trim() : null;
  if (!requestedDate || !requestedTime) return false; // missing date/time handled upstream

  // Collect all allowed "YYYY-MM-DDTHH:MM" from successful availability results
  const allowedSlots = new Set<string>();
  for (const r of params.completedToolResults) {
    if (r.tool !== "availability.check" || r.status !== "success") continue;
    const data = r.data as { slots?: Array<{ starts_at?: string }> } | null | undefined;
    if (!Array.isArray(data?.slots)) continue;
    for (const slot of data.slots) {
      if (typeof slot.starts_at === "string") {
        const date = slot.starts_at.slice(0, 10);
        const hhmm = extractHHMM(slot.starts_at) ?? slot.starts_at.slice(11, 16);
        if (date && hhmm) allowedSlots.add(`${date}T${hhmm}`);
      }
    }
  }

  if (allowedSlots.size === 0) return false; // no slots to validate against

  // Normalize to HH:MM (model may emit "12:00:00" format)
  const normalizedTime = requestedTime.length > 5 ? requestedTime.slice(0, 5) : requestedTime;
  return !allowedSlots.has(`${requestedDate}T${normalizedTime}`);
}

const INVALID_SLOT_REPLIES: Record<string, string> = {
  ru: "Это время недоступно. Выберите, пожалуйста, одно из доступных времён записи.",
  cs: "Tento čas není dostupný. Vyberte prosím jeden z dostupných termínů.",
  en: "That time is not available. Please choose one of the available appointment slots.",
};

export function buildInvalidSlotReply(locale?: string | null): string {
  return INVALID_SLOT_REPLIES[resolveLocaleKey(locale)];
}

// ── Slot proof guard ──────────────────────────────────────────────────────────

import type { AvailableSlot } from "./bookingProcessState.ts";

/**
 * Returns true when booking.apply is pending but there is no verified slot proof:
 * no successful availability.check in the current turn AND no selectedSlot from
 * booking process state that matches the requested date and time.
 *
 * Only fires when completedToolResults contains no successful availability.check —
 * when avail.check results are present, shouldInterceptInvalidSlotTime handles
 * time mismatches. Missing date/time is handled upstream by bookingApplyArgsMissingSlot.
 */
export function shouldInterceptMissingSlotProof(params: {
  pendingToolRequests: RuntimeAgentToolRequest[];
  completedToolResults: RuntimeAgentToolResult[];
  selectedSlot?: AvailableSlot | null;
}): boolean {
  if (!hasBookingApplyPending(params.pendingToolRequests)) return false;

  const req = params.pendingToolRequests.find((r) => r.tool === "booking.apply");
  if (!req) return false;

  const requestedDate =
    typeof req.arguments.requested_date === "string" ? req.arguments.requested_date.trim() : null;
  const requestedTime =
    typeof req.arguments.requested_time === "string" ? req.arguments.requested_time.trim() : null;

  // Missing date/time handled upstream by bookingApplyArgsMissingSlot
  if (!requestedDate || !requestedTime) return false;

  // If successful avail.check results exist in this turn, let shouldInterceptInvalidSlotTime
  // handle the mismatch case — don't double-intercept.
  const hasSuccessfulAvailCheck = params.completedToolResults.some(
    (r) => r.tool === "availability.check" && r.status === "success",
  );
  if (hasSuccessfulAvailCheck) return false;

  // No avail.check in this turn — check if selectedSlot from state covers the request.
  const slot = params.selectedSlot;
  if (slot?.starts_at) {
    const slotDate = slot.starts_at.slice(0, 10);
    const slotTime = extractHHMM(slot.starts_at) ?? slot.starts_at.slice(11, 16);
    const normalizedReq = requestedTime.length > 5 ? requestedTime.slice(0, 5) : requestedTime;
    if (slotDate === requestedDate && slotTime === normalizedReq) return false;
  }

  return true;
}

const MISSING_SLOT_PROOF_REPLIES: Record<string, string> = {
  ru: "Сначала проверим доступное время. На какую дату вас записать?",
  cs: "Nejdříve zkontrolujeme dostupné termíny. Na jaký den vás zapsat?",
  en: "Let me check available times first. What date works for you?",
};

export function buildMissingSlotProofReply(locale?: string | null): string {
  return MISSING_SLOT_PROOF_REPLIES[resolveLocaleKey(locale)];
}

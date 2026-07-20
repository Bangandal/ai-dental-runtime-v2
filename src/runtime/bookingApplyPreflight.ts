import type { RuntimeAgentToolRequest, RuntimeAgentToolResult, ChannelContact, ProvidedPhone } from "./openaiRuntimeAgent.ts";
import { hasTrustedPhone, hasBookingContactPhone, hasBookingApplyPending } from "./bookingContactGuard.ts";

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
  channelContact: ChannelContact | undefined | null;
  providedPhone?: ProvidedPhone | null;
}): boolean {
  return (
    hasBookingApplyPending(params.pendingToolRequests) &&
    !hasBookingContactPhone({ channelContact: params.channelContact, providedPhone: params.providedPhone })
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

// ── Slot validity / proof guards ──────────────────────────────────────────────

import type { AvailableSlot } from "./bookingProcessState.ts";
import type { AuthoritativeAvailabilityAttempt } from "./availabilityActionTruth.ts";
import type { AvailabilityEvidence, SelectedSlotProof } from "./slotEvidence.ts";
import { validateBookingSlotEvidence } from "./slotEvidence.ts";

/** Shared params for both slot evidence guards. */
interface SlotEvidenceGuardParams {
  pendingToolRequests: RuntimeAgentToolRequest[];
  currentAvailabilityAttempt: AuthoritativeAvailabilityAttempt;
  activeAvailabilityEvidence: AvailabilityEvidence | null | undefined;
  selectedSlot?: AvailableSlot | null;
  selectedSlotProof?: SelectedSlotProof | null;
}

/**
 * Returns true when booking.apply is pending and there is no authoritative evidence
 * or no verified selected-slot proof to authorize the booking slot.
 *
 * Covers:
 *   - no availability.check attempted (or failed) this turn AND no persisted evidence
 *   - persisted evidence exists but selected_slot_proof is absent or mismatched
 *
 * Does NOT fire when the slot is simply wrong (i.e. exists in evidence but doesn't
 * match the request) — that case is handled by shouldInterceptInvalidSlotDateTime.
 */
export function shouldInterceptMissingSlotProof(params: SlotEvidenceGuardParams): boolean {
  if (!hasBookingApplyPending(params.pendingToolRequests)) return false;
  const req = params.pendingToolRequests.find((r) => r.tool === "booking.apply");
  if (!req) return false;

  // Missing date/time is handled upstream by bookingApplyArgsMissingSlot.
  const hasDate = typeof req.arguments.requested_date === "string" && !!req.arguments.requested_date.trim();
  const hasTime = typeof req.arguments.requested_time === "string" && !!req.arguments.requested_time.trim();
  if (!hasDate || !hasTime) return false;

  const result = validateBookingSlotEvidence({
    bookingApplyRequest: req,
    currentAvailabilityAttempt: params.currentAvailabilityAttempt,
    activeAvailabilityEvidence: params.activeAvailabilityEvidence,
    selectedSlot: params.selectedSlot,
    selectedSlotProof: params.selectedSlotProof,
  });
  if (result.ok) return false;
  // Fire for evidence/proof-absence reasons; leave slot-mismatch to shouldInterceptInvalidSlotDateTime.
  return (
    result.reason === "no_authoritative_availability_evidence" ||
    result.reason === "selected_slot_proof_missing" ||
    result.reason === "selected_slot_proof_mismatch"
  );
}

const MISSING_SLOT_PROOF_REPLIES: Record<string, string> = {
  ru: "Сначала проверим доступное время. На какую дату вас записать?",
  cs: "Nejdříve zkontrolujeme dostupné termíny. Na jaký den vás zapsat?",
  en: "Let me check available times first. What date works for you?",
};

export function buildMissingSlotProofReply(locale?: string | null): string {
  return MISSING_SLOT_PROOF_REPLIES[resolveLocaleKey(locale)];
}

/**
 * Returns true when booking.apply requests a full date+time that is NOT present in the
 * authoritative availability evidence (current-turn or persisted).
 *
 * Covers:
 *   - slot exists in evidence but the requested date+time doesn't match any allowed key
 *   - cross-date booking attempt where the time matches but the date differs
 *
 * Does NOT fire when evidence is entirely absent — that case is caught first by
 * shouldInterceptMissingSlotProof.
 */
export function shouldInterceptInvalidSlotDateTime(params: SlotEvidenceGuardParams): boolean {
  if (!hasBookingApplyPending(params.pendingToolRequests)) return false;
  const req = params.pendingToolRequests.find((r) => r.tool === "booking.apply");
  if (!req) return false;

  const hasDate = typeof req.arguments.requested_date === "string" && !!req.arguments.requested_date.trim();
  const hasTime = typeof req.arguments.requested_time === "string" && !!req.arguments.requested_time.trim();
  if (!hasDate || !hasTime) return false;

  const result = validateBookingSlotEvidence({
    bookingApplyRequest: req,
    currentAvailabilityAttempt: params.currentAvailabilityAttempt,
    activeAvailabilityEvidence: params.activeAvailabilityEvidence,
    selectedSlot: params.selectedSlot,
    selectedSlotProof: params.selectedSlotProof,
  });
  if (result.ok) return false;
  return result.reason === "slot_not_in_authoritative_evidence";
}

const INVALID_SLOT_REPLIES: Record<string, string> = {
  ru: "Это время недоступно. Выберите, пожалуйста, одно из доступных времён записи.",
  cs: "Tento čas není dostupný. Vyberte prosím jeden z dostupných termínů.",
  en: "That time is not available. Please choose one of the available appointment slots.",
};

export function buildInvalidSlotReply(locale?: string | null): string {
  return INVALID_SLOT_REPLIES[resolveLocaleKey(locale)];
}

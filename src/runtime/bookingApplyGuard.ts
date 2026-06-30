import type { RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";

export interface BookingApplyActionTruth {
  tool: "booking.apply";
  booking_status: string;
  created_visit: boolean;
  may_claim_booked: boolean;
  cliniccard_visit_id: string | null;
  allowed_claims: {
    can_say_booking_created: boolean;
    can_say_booking_confirmed: boolean;
  };
  required_next_action: "none" | "ask_for_phone" | "offer_another_time" | "admin_handoff" | "technical_fallback";
}

/** True only when booking.apply returned all four proof fields indicating visit_created. */
export function hasSuccessfulBookingApplyProof(results: RuntimeAgentToolResult[]): boolean {
  return results.some((r) => {
    if (r.tool !== "booking.apply" || r.status !== "success") return false;
    const d = r.data as Record<string, unknown> | null | undefined;
    if (!d || typeof d !== "object") return false;
    return (
      d.booking_status === "visit_created" &&
      d.created_visit === true &&
      d.may_claim_booked === true &&
      typeof d.cliniccard_visit_id === "string" &&
      d.cliniccard_visit_id.length > 0
    );
  });
}

/** Builds structured action truth from booking.apply tool results for the model's second call. */
export function buildBookingApplyActionTruth(results: RuntimeAgentToolResult[]): BookingApplyActionTruth | null {
  const bookingResult = results.find((r) => r.tool === "booking.apply");
  if (!bookingResult) return null;

  const d = bookingResult.data as Record<string, unknown> | null | undefined;
  const bookingStatus = typeof d?.booking_status === "string" ? d.booking_status : "unknown";
  const createdVisit = d?.created_visit === true;
  const mayClaimBooked = d?.may_claim_booked === true;
  const clinicCardVisitId = typeof d?.cliniccard_visit_id === "string" ? d.cliniccard_visit_id : null;

  const requiredNextAction = resolveRequiredNextAction(bookingStatus);

  return {
    tool: "booking.apply",
    booking_status: bookingStatus,
    created_visit: createdVisit,
    may_claim_booked: mayClaimBooked,
    cliniccard_visit_id: clinicCardVisitId,
    allowed_claims: {
      can_say_booking_created: mayClaimBooked,
      can_say_booking_confirmed: mayClaimBooked,
    },
    required_next_action: requiredNextAction,
  };
}

function resolveRequiredNextAction(bookingStatus: string): BookingApplyActionTruth["required_next_action"] {
  switch (bookingStatus) {
    case "visit_created": return "none";
    case "missing_phone": return "ask_for_phone";
    case "slot_conflict": return "offer_another_time";
    case "booking_write_disabled": return "admin_handoff";
    default: return "technical_fallback";
  }
}

/**
 * Emergency fallback reply — only when the model call itself fails (error, malformed response).
 * Not the main booking reply path. Locale-aware.
 */
export function buildBookingApplyEmergencyFallback(
  results: RuntimeAgentToolResult[],
  locale?: string | null,
): string {
  const bookingResult = results.find((r) => r.tool === "booking.apply");
  const status =
    typeof (bookingResult?.data as Record<string, unknown> | undefined)?.booking_status === "string"
      ? (bookingResult!.data as Record<string, unknown>).booking_status as string
      : "unknown";

  const normalized = String(locale ?? "").toLowerCase();

  if (normalized.startsWith("en")) {
    if (status === "missing_phone") return "I need your phone number to complete the booking. Please share your contact or type your number.";
    if (status === "slot_conflict") return "That time slot is no longer available. I can check other times.";
    if (status === "booking_write_disabled") return "Online booking is currently unavailable. The clinic team will follow up.";
    return "I'm unable to confirm the booking automatically. The clinic team will follow up.";
  }

  if (normalized.startsWith("cs")) {
    if (status === "missing_phone") return "Pro rezervaci potřebuji váš telefon. Sdílejte kontakt nebo napište číslo.";
    if (status === "slot_conflict") return "Tento čas je obsazen. Mohu zkontrolovat jiný termín.";
    if (status === "booking_write_disabled") return "Online rezervace není momentálně dostupná. Tým kliniky vás kontaktuje.";
    return "Automatické potvrzení není dostupné. Tým kliniky vás kontaktuje.";
  }

  // Default: Russian
  if (status === "missing_phone") return "Для записи нужен номер телефона. Поделитесь контактом или напишите номер.";
  if (status === "slot_conflict") return "Это время уже недоступно. Могу проверить другое время.";
  if (status === "booking_write_disabled") return "Онлайн-запись временно недоступна. Передам данные администратору клиники.";
  return "Пока не могу подтвердить запись автоматически. Передам данные администратору клиники.";
}

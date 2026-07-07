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
  required_next_action:
    | "none"
    | "ask_for_phone"
    | "ask_for_slot"
    | "ask_for_name"
    | "ask_for_service"
    | "offer_another_time"
    | "ask_for_alternative_time"
    | "choose_from_available_slots"
    | "admin_handoff"
    | "technical_fallback";
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
  // allowed_claims must reflect full proof (all four fields), not may_claim_booked alone —
  // a partial/malformed tool result could set may_claim_booked=true without the rest.
  const hasFullProof = hasSuccessfulBookingApplyProof(results);

  return {
    tool: "booking.apply",
    booking_status: bookingStatus,
    created_visit: createdVisit,
    may_claim_booked: mayClaimBooked,
    cliniccard_visit_id: clinicCardVisitId,
    allowed_claims: {
      can_say_booking_created: hasFullProof,
      can_say_booking_confirmed: hasFullProof,
    },
    required_next_action: requiredNextAction,
  };
}

function resolveRequiredNextAction(bookingStatus: string): BookingApplyActionTruth["required_next_action"] {
  switch (bookingStatus) {
    case "visit_created":           return "none";
    case "missing_phone":
    case "missing_trusted_phone":   return "ask_for_phone";
    case "missing_slot":            return "ask_for_slot";
    case "missing_patient_name":    return "ask_for_name";
    case "missing_service":         return "ask_for_service";
    case "slot_conflict":
    case "no_available_slots":
    case "invalid_slot":
    case "past_time":               return "offer_another_time";
    case "booking_write_disabled":  return "admin_handoff";
    default:                        return "technical_fallback";
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

  // No handoff/admin-notification side effect is created anywhere in this path — do not
  // promise clinic staff will follow up or reach out. Direct the patient to contact the
  // clinic directly instead of claiming an outreach that never happens.
  if (normalized.startsWith("en")) {
    if (status === "visit_created") return "Your appointment has been saved in our system, but a technical error prevented the confirmation message from sending. Please contact the clinic to verify your booking details.";
    if (status === "missing_phone") return "I need your phone number to complete the booking. Please share your contact or type your number.";
    if (status === "slot_conflict") return "That time slot is no longer available. I can check other times.";
    if (status === "booking_write_disabled") return "Online booking is currently unavailable. Please contact the clinic directly to book your appointment.";
    return "I'm unable to confirm the booking automatically right now. Please contact the clinic directly.";
  }

  if (normalized.startsWith("cs")) {
    if (status === "visit_created") return "Vaše rezervace byla uložena v systému, ale při odeslání potvrzení došlo k technické chybě. Kontaktujte prosím kliniku pro ověření podrobností.";
    if (status === "missing_phone") return "Pro rezervaci potřebuji váš telefon. Sdílejte kontakt nebo napište číslo.";
    if (status === "slot_conflict") return "Tento čas je obsazen. Mohu zkontrolovat jiný termín.";
    if (status === "booking_write_disabled") return "Online rezervace není momentálně dostupná. Kontaktujte prosím kliniku přímo pro rezervaci.";
    return "Momentálně nemohu automaticky potvrdit rezervaci. Kontaktujte prosím kliniku přímo.";
  }

  // Default: Russian
  // visit_created: booking IS in ClinicCard — never say "не могу подтвердить".
  if (status === "visit_created") return "Запись создана в системе, но при отправке ответа произошла техническая ошибка. Пожалуйста, уточните детали у клиники.";
  if (status === "missing_phone") return "Для записи нужен номер телефона. Поделитесь контактом или напишите номер.";
  if (status === "slot_conflict") return "Это время уже недоступно. Могу проверить другое время.";
  if (status === "booking_write_disabled") return "Онлайн-запись временно недоступна. Пожалуйста, свяжитесь с клиникой напрямую для записи.";
  return "Пока не могу подтвердить запись автоматически. Пожалуйста, свяжитесь с клиникой напрямую.";
}

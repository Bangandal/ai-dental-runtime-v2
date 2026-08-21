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
    | "clarify_subject"
    | "admin_handoff"
    | "technical_fallback";
}

/**
 * True when a single booking.apply tool result carries the complete ClinicCard proof:
 * status=success, booking_status=visit_created, created_visit=true, may_claim_booked=true,
 * and a non-empty cliniccard_visit_id. Used by postUpdateBookingSubjects to gate subject
 * status transitions. Partial results must never mark a subject as booked.
 */
export function hasCompleteBookingApplyProof(result: RuntimeAgentToolResult | undefined): boolean {
  if (!result || result.tool !== "booking.apply" || result.status !== "success") return false;
  const d = result.data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return false;
  return (
    d.booking_status === "visit_created" &&
    d.created_visit === true &&
    d.may_claim_booked === true &&
    typeof d.cliniccard_visit_id === "string" &&
    d.cliniccard_visit_id.trim().length > 0
  );
}

/** True only when booking.apply returned all proof fields indicating visit_created (array variant). */
export function hasSuccessfulBookingApplyProof(results: RuntimeAgentToolResult[]): boolean {
  return results.some((r) => hasCompleteBookingApplyProof(r));
}

/**
 * Finds the authoritative booking.apply result from a list of tool results.
 *
 * Priority:
 *   1. Last result with a complete ClinicCard proof.
 *   2. If no complete proof exists, the last booking.apply result.
 *
 * Last wins so that a successful later result overrides an earlier blocked result.
 * Fields are never mixed across results.
 */
export function findAuthoritativeBookingApplyResult(
  results: RuntimeAgentToolResult[],
): RuntimeAgentToolResult | undefined {
  const withProof = results.filter((r) => hasCompleteBookingApplyProof(r));
  if (withProof.length > 0) return withProof[withProof.length - 1];
  const all = results.filter((r) => r.tool === "booking.apply");
  return all.length > 0 ? all[all.length - 1] : undefined;
}

/** Builds structured action truth from booking.apply tool results for the model's second call. */
export function buildBookingApplyActionTruth(results: RuntimeAgentToolResult[]): BookingApplyActionTruth | null {
  const bookingResult = findAuthoritativeBookingApplyResult(results);
  if (!bookingResult) return null;

  const d = bookingResult.data as Record<string, unknown> | null | undefined;
  const bookingStatus = typeof d?.booking_status === "string" ? d.booking_status : "unknown";
  const createdVisit = d?.created_visit === true;
  const mayClaimBooked = d?.may_claim_booked === true;
  const clinicCardVisitId = typeof d?.cliniccard_visit_id === "string" ? d.cliniccard_visit_id : null;

  const requiredNextAction = resolveRequiredNextAction(bookingStatus);
  const hasFullProof = hasCompleteBookingApplyProof(bookingResult);

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
    case "visit_created": return "none";
    case "missing_phone":
    case "missing_trusted_phone": return "ask_for_phone";
    case "missing_slot": return "ask_for_slot";
    case "missing_patient_name": return "ask_for_name";
    case "missing_service": return "ask_for_service";
    case "slot_conflict":
    case "no_available_slots":
    case "invalid_slot":
    case "past_time": return "offer_another_time";
    case "subject_resolution_conflict": return "clarify_subject";
    case "pending_phone_classification": return "none";
    case "identity_ambiguous":
    case "booking_write_disabled":
    case "booking_outcome_unknown": return "admin_handoff";
    default: return "technical_fallback";
  }
}

/**
 * Emergency fallback reply, only when the model call itself fails.
 * Not the main booking reply path. Locale-aware.
 */
export function buildBookingApplyEmergencyFallback(
  results: RuntimeAgentToolResult[],
  locale?: string | null,
): string {
  const bookingResult = findAuthoritativeBookingApplyResult(results);
  const status =
    typeof (bookingResult?.data as Record<string, unknown> | undefined)?.booking_status === "string"
      ? (bookingResult!.data as Record<string, unknown>).booking_status as string
      : "unknown";

  const normalized = String(locale ?? "").toLowerCase();
  const hasFullProof = hasCompleteBookingApplyProof(bookingResult);

  if (normalized.startsWith("en")) {
    if (hasFullProof) return "Your appointment has been saved in our system, but a technical error prevented the confirmation message from sending. Please contact the clinic to verify your booking details.";
    if (status === "missing_phone") return "I need your phone number to complete the booking. Please share your contact or type your number.";
    if (status === "slot_conflict") return "That time slot is no longer available. I can check other times.";
    if (status === "identity_ambiguous") return "I can't safely match this booking to the correct patient record. Please contact the clinic so staff can verify the patient before booking.";
    if (status === "booking_write_disabled") return "Online booking is currently unavailable. Please contact the clinic directly to book your appointment.";
    if (status === "booking_outcome_unknown") return "I couldn't verify whether ClinicCard completed the booking. I won't repeat the booking automatically because that could create a duplicate. Please contact the clinic so staff can reconcile it.";
    return "I'm unable to confirm the booking automatically right now. Please contact the clinic directly.";
  }

  if (normalized.startsWith("cs")) {
    if (hasFullProof) return "Vaše rezervace byla uložena v systému, ale při odeslání potvrzení došlo k technické chybě. Kontaktujte prosím kliniku pro ověření podrobností.";
    if (status === "missing_phone") return "Pro rezervaci potřebuji váš telefon. Sdílejte kontakt nebo napište číslo.";
    if (status === "slot_conflict") return "Tento čas je obsazen. Mohu zkontrolovat jiný termín.";
    if (status === "identity_ambiguous") return "Rezervaci nelze bezpečně přiřadit ke správnému pacientovi. Kontaktujte prosím kliniku, aby personál ověřil pacienta před vytvořením rezervace.";
    if (status === "booking_write_disabled") return "Online rezervace není momentálně dostupná. Kontaktujte prosím kliniku přímo pro rezervaci.";
    if (status === "booking_outcome_unknown") return "Nepodařilo se ověřit, zda ClinicCard rezervaci dokončil. Rezervaci automaticky nezopakuji, protože by mohl vzniknout duplikát. Kontaktujte prosím kliniku pro ověření.";
    return "Momentálně nemohu automaticky potvrdit rezervaci. Kontaktujte prosím kliniku přímo.";
  }

  if (hasFullProof) return "Запись создана в системе, но при отправке ответа произошла техническая ошибка. Пожалуйста, уточните детали у клиники.";
  if (status === "missing_phone") return "Для записи нужен номер телефона. Поделитесь контактом или напишите номер.";
  if (status === "slot_conflict") return "Это время уже недоступно. Могу проверить другое время.";
  if (status === "identity_ambiguous") return "Не могу безопасно определить карточку пациента для этой записи. Пожалуйста, свяжитесь с клиникой, чтобы администратор уточнил данные перед записью.";
  if (status === "booking_write_disabled") return "Онлайн-запись временно недоступна. Пожалуйста, свяжитесь с клиникой напрямую для записи.";
  if (status === "booking_outcome_unknown") return "Не удалось проверить, завершил ли ClinicCard запись. Я не буду повторять её автоматически, чтобы не создать дубль. Пожалуйста, свяжитесь с клиникой для сверки.";
  return "Пока не могу подтвердить запись автоматически. Пожалуйста, свяжитесь с клиникой напрямую.";
}

import type { RuntimeAgentToolResult } from "./openaiRuntimeAgent.ts";

// Matches confirmed-booking forms but not derivational forms like "подтверждения"
// (verbal noun meaning "for confirmation"). Uses a negative lookahead on Cyrillic
// chars that are typical inflection continuations rather than confirmation endings.
const UNSAFE_BOOKING_TEXT_RE =
  /записан[аоы]?(?:[^а-яё]|$)|запись\s+(?:создана|подтверждена)|подтвержд[её]н[аоы]?(?:[^а-яё]|$)|\bbooked\b|\bconfirmed\b|\breserved\b/i;

/** True when booking.apply returned all four proof fields indicating visit_created. */
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

/** True when the reply contains a booking-confirmation forbidden pattern (case-insensitive). */
export function hasUnsafeBookingConfirmationText(reply: string): boolean {
  return UNSAFE_BOOKING_TEXT_RE.test(reply);
}

/** Returns a safe fallback reply based on the first booking.apply result's booking_status. */
export function buildBookingApplySafeFallback(results: RuntimeAgentToolResult[]): string {
  const bookingResult = results.find((r) => r.tool === "booking.apply");
  const status =
    typeof (bookingResult?.data as Record<string, unknown> | undefined)?.booking_status === "string"
      ? (bookingResult!.data as Record<string, unknown>).booking_status as string
      : "default";

  switch (status) {
    case "booking_write_disabled":
      return "Пока не могу подтвердить запись онлайн. Я передам данные администратору клиники.";
    case "missing_phone":
      return "Для записи нужен ваш номер телефона. Поделитесь контактом через кнопку или напишите номер сообщением.";
    case "slot_conflict":
      return "Это время уже недоступно. Могу проверить другое время.";
    case "config_missing":
    case "cliniccard_write_failed":
    default:
      return "Пока не могу подтвердить запись автоматически. Передам данные администратору клиники.";
  }
}

/**
 * Guards the final reply returned after booking.apply execution.
 *
 * If booking.apply ran but proof is missing and the reply contains forbidden
 * booking-confirmation text, replaces the reply with a safe status-based fallback.
 * No-ops when booking.apply was not in the tool results, or proof is complete.
 */
export function guardBookingApplyFinalReply(
  reply: string,
  toolResults: RuntimeAgentToolResult[],
  _locale?: string | null,
): string {
  const hasBookingApplyResult = toolResults.some((r) => r.tool === "booking.apply");
  if (!hasBookingApplyResult) return reply;
  if (hasSuccessfulBookingApplyProof(toolResults)) return reply;
  if (!hasUnsafeBookingConfirmationText(reply)) return reply;
  return buildBookingApplySafeFallback(toolResults);
}

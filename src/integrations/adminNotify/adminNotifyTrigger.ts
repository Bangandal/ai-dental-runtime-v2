import type { BookingApplyActionTruth } from "../../runtime/bookingApplyGuard.ts";

/**
 * V1 trigger scope: booking.apply failure paths only (admin_handoff / technical_fallback).
 * required_next_action="technical_fallback" already covers config_missing and
 * cliniccard_write_failed (see bookingApplyGuard.resolveRequiredNextAction defaults),
 * and "admin_handoff" covers booking_write_disabled.
 * visit_created, missing_phone, slot_conflict do not trigger admin notification.
 */
export function resolveAdminNotifyReason(actionTruth: BookingApplyActionTruth | null): string | null {
  if (!actionTruth) return null;
  if (
    actionTruth.required_next_action === "admin_handoff" ||
    actionTruth.required_next_action === "technical_fallback"
  ) {
    return actionTruth.booking_status;
  }
  return null;
}

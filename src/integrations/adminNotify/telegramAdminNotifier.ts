import { sendTelegramMessage } from "../../runtime/telegramSender.ts";
import type { AdminNotifyConfig } from "./adminNotifyConfig.ts";
import type { AdminNotifier, AdminNotificationPayload, AdminNotificationResult } from "./adminNotifyTypes.ts";

export interface TelegramAdminNotifierDeps {
  config: AdminNotifyConfig;
  botToken: string | null;
  fetch?: typeof globalThis.fetch;
}

/** Returns a notifier that reflects config/token state honestly. */
export function createAdminNotifier(deps: TelegramAdminNotifierDeps): AdminNotifier {
  return {
    async notify(payload: AdminNotificationPayload): Promise<AdminNotificationResult> {
      if (deps.config.mode === "disabled") {
        return {
          type: "admin_notification",
          status: "disabled",
          channel: "telegram",
          reason: payload.reason,
          trace_id: payload.trace_id,
        };
      }

      if (!deps.config.telegram_chat_id || !deps.botToken) {
        return {
          type: "admin_notification",
          status: "not_configured",
          channel: "telegram",
          reason: payload.reason,
          trace_id: payload.trace_id,
        };
      }

      const text = buildAdminNotificationText(payload);
      const sendResult = await sendTelegramMessage({
        botToken: deps.botToken,
        chatId: deps.config.telegram_chat_id,
        messageThreadId: deps.config.telegram_thread_id,
        text,
        fetch: deps.fetch,
      });

      if (!sendResult.ok) {
        return {
          type: "admin_notification",
          status: "failed",
          channel: "telegram",
          reason: payload.reason,
          trace_id: payload.trace_id,
          error_code: sendResult.error ?? "telegram_send_failed",
        };
      }

      return {
        type: "admin_notification",
        status: "sent",
        channel: "telegram",
        reason: payload.reason,
        trace_id: payload.trace_id,
      };
    },
  };
}

function buildAdminNotificationText(payload: AdminNotificationPayload): string {
  const lines = [
    payload.staff_request ? `Staff request (${payload.staff_request.kind})` : `Booking needs attention (${payload.reason})`,
    payload.staff_request ? `Request ID: ${payload.staff_request.request_id}` : null,
    payload.staff_request ? `Patient-reported summary: ${payload.staff_request.summary}` : null,
    payload.staff_request?.preferred_contact_window
      ? `Preferred CALLBACK window (not an appointment): ${payload.staff_request.preferred_contact_window}` : null,
    `Clinic: ${payload.clinic_code ?? payload.clinic_id}`,
    `Channel: ${payload.channel} / ${payload.chat_id ?? payload.external_user_id ?? "unknown"}`,
    payload.patient_display_name ? `Patient: ${payload.patient_display_name}` : null,
    payload.requested_service ? `Service: ${payload.requested_service}` : null,
    payload.requested_date || payload.requested_time
      ? `Requested: ${payload.requested_date ?? "?"} ${payload.requested_time ?? ""}`.trim()
      : null,
    `Phone available: ${payload.phone_available ? "yes" : "no"}${payload.phone_source ? ` (${payload.phone_source})` : ""}`,
    `Booking status: ${payload.booking_status}`,
    `Patient message: ${payload.original_message}`,
    `trace_id: ${payload.trace_id}`,
    `Time: ${payload.timestamp}`,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

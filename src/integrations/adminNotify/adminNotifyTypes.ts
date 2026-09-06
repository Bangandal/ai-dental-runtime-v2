export type AdminNotificationStatus = "sent" | "queued" | "failed" | "not_configured" | "disabled";

export interface AdminNotificationPayload {
  clinic_id: string;
  clinic_code: string | null;
  channel: string;
  chat_id: string | null;
  external_user_id: string | null;
  trace_id: string;
  patient_display_name: string | null;
  phone_source: string | null;
  phone_available: boolean;
  original_message: string;
  requested_service: string | null;
  requested_date: string | null;
  requested_time: string | null;
  booking_status: string;
  created_visit: boolean;
  may_claim_booked: boolean;
  required_next_action: string;
  reason: string;
  timestamp: string;
  staff_request?: import("../../runtime/staffRequest.ts").StaffRequest & { request_id: string };
}

export interface AdminNotificationResult {
  type: "admin_notification";
  status: AdminNotificationStatus;
  channel: "telegram";
  reason: string;
  trace_id: string;
  provider_message_id?: string | null;
  error_code?: string | null;
}

export interface AdminNotifier {
  notify(payload: AdminNotificationPayload): Promise<AdminNotificationResult>;
}

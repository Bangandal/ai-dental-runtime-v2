import type { AdminNotifier, AdminNotificationResult } from "../integrations/adminNotify/adminNotifyTypes.ts";
import type { ChannelContact } from "./openaiRuntimeAgent.ts";
import type {
  StaffNotificationContext,
  StaffRequest,
  StaffRequestProof,
  StaffRequestRepository,
} from "./staffRequest.ts";

export interface StaffRequestAuthorityInput {
  clinic_id: string;
  clinic_code?: string | null;
  contact_id: string | null;
  trace_id: string;
  idempotency_key: string | null;
  channel: string;
  chat_id?: string | null;
  external_user_id?: string | null;
  source_message: string;
  request: StaffRequest;
  channel_contact?: ChannelContact | null;
  repository?: StaffRequestRepository;
  adminNotifier?: AdminNotifier;
}

export interface StaffRequestAuthorityResult {
  request: StaffRequest;
  proof: StaffRequestProof;
  delivery: AdminNotificationResult | null;
}

function failedProof(kind: StaffRequest["kind"]): StaffRequestProof {
  return {
    type: "staff_request",
    kind,
    request_id: null,
    request_saved: false,
    delivery_status: "failed",
    delivery_recorded: false,
    may_claim_notified: false,
  };
}

function buildNotificationContext(input: StaffRequestAuthorityInput): StaffNotificationContext {
  return {
    clinic_id: input.clinic_id,
    clinic_code: input.clinic_code ?? null,
    channel: input.channel,
    chat_id: input.chat_id ?? null,
    external_user_id: input.external_user_id ?? null,
    trace_id: input.trace_id,
    patient_display_name: input.request.person_ref,
    phone_source: input.channel_contact?.phone_source ?? null,
    phone_available: Boolean(input.channel_contact?.phone_number),
    original_message: input.source_message,
    requested_service: null,
    requested_date: null,
    requested_time: null,
    booking_status: "not_requested",
    created_visit: false,
    may_claim_booked: false,
    required_next_action: "staff_review",
    reason: input.request.kind,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Single authority for staff-side effects across text and voice.
 * A model proposal has no execution power until this function durably saves it.
 */
export async function executeStaffRequestAuthority(
  input: StaffRequestAuthorityInput,
): Promise<StaffRequestAuthorityResult> {
  const proof = failedProof(input.request.kind);

  if (input.request.kind === "live_transfer" && input.channel !== "voice") {
    return { request: input.request, proof, delivery: null };
  }

  if (!input.repository || !input.contact_id || !input.idempotency_key) {
    return { request: input.request, proof, delivery: null };
  }

  const notificationContext = buildNotificationContext(input);
  const saved = await input.repository.create({
    clinic_id: input.clinic_id,
    contact_id: input.contact_id,
    trace_id: input.idempotency_key,
    request: input.request,
    source_message: input.source_message,
    notification_context: notificationContext,
  }).catch(() => null);

  if (!saved?.ok) {
    return { request: input.request, proof, delivery: null };
  }

  proof.request_id = saved.data.request_id;
  proof.request_saved = true;
  proof.delivery_status = saved.data.delivery_status;
  proof.notification_queued = saved.data.notification_queued === true;
  proof.delivery_recorded = saved.data.delivery_status !== "pending"
    && saved.data.delivery_status !== "queued";

  let delivery: AdminNotificationResult | null = null;

  // Production Supabase queues delivery atomically. This inline branch remains only
  // for in-memory/test repositories that intentionally do not implement the outbox.
  if (!saved.data.notification_queued && saved.data.created) {
    const base: AdminNotificationResult = {
      type: "admin_notification",
      status: "not_configured",
      channel: "telegram",
      reason: input.request.kind,
      trace_id: input.trace_id,
    };
    delivery = input.adminNotifier
      ? await input.adminNotifier.notify({
          ...notificationContext,
          staff_request: { ...input.request, request_id: saved.data.request_id },
        }).catch(() => ({
          ...base,
          status: "failed" as const,
          error_code: "staff_notification_exception",
        }))
      : base;

    proof.delivery_status = delivery.status;
    const recorded = await input.repository.recordDelivery({
      clinic_id: input.clinic_id,
      contact_id: input.contact_id,
      request_id: saved.data.request_id,
      delivery,
    }).catch(() => null);
    proof.delivery_recorded = recorded?.ok === true;
  }

  proof.may_claim_notified = proof.request_saved && proof.delivery_status === "sent";
  return { request: input.request, proof, delivery };
}

import type { RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestratorLegacy.ts";
import type { StaffRequest, StaffRequestProof } from "./staffRequest.ts";
import type { AdminNotificationResult } from "../integrations/adminNotify/adminNotifyTypes.ts";

export type InboundMediaKind = "photo" | "document";

export interface InboundMediaNotice {
  clinic_code: string;
  channel: "telegram" | "whatsapp";
  external_user_id: string;
  chat_id: string;
  message_id: string;
  update_id?: string | null;
  media_kind: InboundMediaKind;
  patient_display_name?: string | null;
  phone_source?: string | null;
  phone_available?: boolean;
}

export type InboundMediaStaffRequestResult =
  | { outcome: "duplicate" }
  | { outcome: "not_configured" }
  | { outcome: "failed"; reason: string }
  | {
      outcome: "processed";
      proof: StaffRequestProof;
      delivery: AdminNotificationResult | null;
    };

function failedProof(): StaffRequestProof {
  return {
    type: "staff_request",
    request_id: null,
    request_saved: false,
    delivery_status: "failed",
    delivery_recorded: false,
    may_claim_notified: false,
  };
}

/**
 * Deterministic media-only handoff.
 *
 * Photo/document bytes, filenames and provider media ids are intentionally absent from this
 * contract. The channel adapter passes only the fact that a media message arrived plus stable
 * provider message/update ids for dedupe. Runtime persists a document_update request and may
 * notify staff; it never downloads, stores or forwards the media content.
 */
export async function handleInboundMediaStaffRequest(
  input: InboundMediaNotice,
  deps: Pick<
    RuntimeTurnOrchestratorDeps,
    "clinicIdentityResolver" | "turnPersistenceRepository" | "staffRequestRepository" | "adminNotifier"
  >,
): Promise<InboundMediaStaffRequestResult> {
  const {
    clinicIdentityResolver,
    turnPersistenceRepository,
    staffRequestRepository,
    adminNotifier,
  } = deps;
  if (!clinicIdentityResolver || !turnPersistenceRepository || !staffRequestRepository) {
    return { outcome: "not_configured" };
  }

  const clinic = await clinicIdentityResolver.resolveClinicIdentity({
    clinic_identifier: input.clinic_code,
  }).catch(() => null);
  if (!clinic?.ok) return { outcome: "failed", reason: "clinic_not_found" };

  const contact = await turnPersistenceRepository.getOrCreateContact({
    clinic_code: clinic.data.clinic_code,
    channel: input.channel,
    external_user_id: input.external_user_id,
    chat_id: input.chat_id,
    first_name: input.patient_display_name ?? null,
  }).catch(() => null);
  if (!contact?.ok) return { outcome: "failed", reason: "contact_persist_failed" };

  const providerEventId = input.update_id?.trim() || input.message_id.trim();
  if (!providerEventId) return { outcome: "failed", reason: "provider_message_id_missing" };
  const stableKey = `${input.channel}:${input.external_user_id}:media:${providerEventId}`;

  const inbound = await turnPersistenceRepository.registerInboundEvent({
    clinic_id: clinic.data.clinic_id,
    contact_id: contact.data.contact_id,
    channel: input.channel,
    external_user_id: input.external_user_id,
    dedupe_key: stableKey,
    source_message_id: input.message_id,
    source_update_id: input.update_id ?? input.message_id,
    payload: {
      message_type: input.media_kind,
      media_content_downloaded: false,
      media_content_stored: false,
      media_content_forwarded: false,
    },
    trace_id: stableKey,
  }).catch(() => null);
  if (!inbound?.ok) return { outcome: "failed", reason: "inbound_registration_failed" };
  if (inbound.data.is_duplicate === true || inbound.data.accepted === false) {
    return { outcome: "duplicate" };
  }

  const request: StaffRequest = {
    kind: "document_update",
    patient_target: "self",
    person_ref: input.patient_display_name?.trim() || input.external_user_id,
    summary: input.media_kind === "photo"
      ? "Patient sent an image/photo in chat. Runtime did not download, store, or forward the image; staff should open the patient chat and review it there."
      : "Patient sent a document in chat. Runtime did not download, store, or forward the document; staff should open the patient chat and review it there.",
    preferred_contact_window: null,
    reply_language: "ru",
  };

  const saved = await staffRequestRepository.create({
    clinic_id: clinic.data.clinic_id,
    contact_id: contact.data.contact_id,
    trace_id: stableKey,
    request,
    source_message: input.media_kind === "photo" ? "[photo received]" : "[document received]",
  }).catch(() => null);
  if (!saved?.ok) {
    return { outcome: "processed", proof: failedProof(), delivery: null };
  }

  const proof: StaffRequestProof = {
    type: "staff_request",
    request_id: saved.data.request_id,
    request_saved: true,
    delivery_status: saved.data.delivery_status,
    delivery_recorded: saved.data.delivery_status !== "pending",
    may_claim_notified: false,
  };

  let delivery: AdminNotificationResult | null = null;
  if (saved.data.created) {
    const fallback: AdminNotificationResult = {
      type: "admin_notification",
      status: "not_configured",
      channel: "telegram",
      reason: "document_update",
      trace_id: stableKey,
    };
    delivery = adminNotifier
      ? await adminNotifier.notify({
          clinic_id: clinic.data.clinic_id,
          clinic_code: clinic.data.clinic_code,
          channel: input.channel,
          chat_id: input.chat_id,
          external_user_id: input.external_user_id,
          trace_id: stableKey,
          patient_display_name: input.patient_display_name ?? null,
          phone_source: input.phone_source ?? null,
          phone_available: input.phone_available === true,
          original_message: input.media_kind === "photo"
            ? "Patient sent a photo/image in chat. Open the patient chat to review it."
            : "Patient sent a document in chat. Open the patient chat to review it.",
          requested_service: null,
          requested_date: null,
          requested_time: null,
          booking_status: "not_requested",
          created_visit: false,
          may_claim_booked: false,
          required_next_action: "staff_review",
          reason: "document_update",
          timestamp: new Date().toISOString(),
          staff_request: { ...request, request_id: saved.data.request_id },
        }).catch(() => ({ ...fallback, status: "failed" as const, error_code: "staff_notification_exception" }))
      : fallback;

    proof.delivery_status = delivery.status;
    const recorded = await staffRequestRepository.recordDelivery({
      clinic_id: clinic.data.clinic_id,
      contact_id: contact.data.contact_id,
      request_id: saved.data.request_id,
      delivery,
    }).catch(() => null);
    proof.delivery_recorded = recorded?.ok === true;
  }

  proof.may_claim_notified = proof.request_saved && proof.delivery_status === "sent";
  return { outcome: "processed", proof, delivery };
}

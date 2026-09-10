import type { RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestratorLegacy.ts";
import type {
  AdminNotificationResult,
} from "../integrations/adminNotify/adminNotifyTypes.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import {
  parseStaffRequest,
  sanitizeStaffAdditionalReply,
  staffRequestFailureReceipt,
  staffRequestReceipt,
  type StaffNotificationContext,
  type StaffRequest,
  type StaffRequestProof,
} from "./staffRequest.ts";

function value(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function stableStaffRequestKey(context: Record<string, unknown> | undefined): string | null {
  const rawMeta = context?.meta;
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) return null;
  const meta = rawMeta as Record<string, unknown>;
  const messageId = value(meta.message_id);
  const updateId = value(meta.update_id);
  if (!messageId && !updateId) return null;
  const channel = value(context?.channel) ?? "unknown";
  const sender = value(context?.external_user_id) ?? value(context?.chat_id) ?? "unknown";
  return updateId
    ? `${channel}:${sender}:upd:${updateId}`
    : `${channel}:${sender}:msg:${messageId}`;
}

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

function buildNotificationContext(
  input: Parameters<RuntimeTurnOrchestratorDeps["runtimeTurnService"]["runTurn"]>[0],
  request: StaffRequest,
): StaffNotificationContext {
  const context = input.business_context;
  return {
    clinic_id: input.clinic_id,
    clinic_code: value(context?.clinic_code),
    channel: value(context?.channel) ?? "unknown",
    chat_id: value(context?.chat_id),
    external_user_id: value(context?.external_user_id),
    trace_id: input.trace_id ?? "unknown",
    patient_display_name: request.person_ref,
    phone_source: input.channel_contact?.phone_source ?? null,
    phone_available: Boolean(input.channel_contact?.phone_number),
    original_message: input.user_message,
    requested_service: null,
    requested_date: null,
    requested_time: null,
    booking_status: "not_requested",
    created_visit: false,
    may_claim_booked: false,
    required_next_action: "staff_review",
    reason: request.kind,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The agent proposes one staff request; Runtime persists it before any notification.
 * Production Supabase additionally queues the notification in the same transaction.
 * Legacy/test repositories without outbox support retain the synchronous notifier path.
 */
export function withStaffRequestHandling(deps: RuntimeTurnOrchestratorDeps): RuntimeTurnOrchestratorDeps {
  return {
    ...deps,
    runtimeTurnService: {
      async runTurn(input) {
        const result = await deps.runtimeTurnService.runTurn(input);
        if (!isAgentFirstRuntimeEnabled()) return result;

        if (result.debug?.staff_request_invalid === true) {
          const proof = failedProof();
          return {
            ...result,
            final_patient_reply: staffRequestFailureReceipt(input.locale),
            side_effects: [...(result.side_effects ?? []), proof],
            debug: {
              ...result.debug,
              staff_request: { ...proof, reason: "invalid_proposal" },
            },
          };
        }

        const request = parseStaffRequest(result.staff_request);
        if (!request) return result;

        const context = input.business_context;
        const channel = value(context?.channel) ?? "unknown";

        // A live transfer is transport-specific authority. Never create one from text
        // channels or from a model-only claim. Voice persists first, then call control
        // may act only on the saved side-effect proof.
        if (request.kind === "live_transfer" && channel !== "voice") {
          const proof: StaffRequestProof = { ...failedProof(), kind: request.kind };
          return {
            ...result,
            final_patient_reply: staffRequestFailureReceipt(request.reply_language),
            staff_request_state: { request, proof },
            side_effects: [...(result.side_effects ?? []), proof],
            debug: {
              ...result.debug,
              staff_request: { ...proof, reason: "live_transfer_requires_voice" },
            },
          };
        }

        const proof: StaffRequestProof = { ...failedProof(), kind: request.kind };
        let delivery: AdminNotificationResult | null = null;
        const repository = deps.staffRequestRepository;
        const idempotencyKey = stableStaffRequestKey(input.business_context);
        const notificationContext = buildNotificationContext(input, request);

        // The durable request key comes from the provider event, never the random Runtime trace.
        // In production, notification_context is inserted into an outbox in the same transaction.
        if (repository && input.contact_id && input.trace_id && idempotencyKey) {
          const saved = await repository.create({
            clinic_id: input.clinic_id,
            contact_id: input.contact_id,
            trace_id: idempotencyKey,
            request,
            source_message: input.user_message,
            notification_context: notificationContext,
          }).catch(() => null);
          if (saved?.ok) {
            proof.request_id = saved.data.request_id;
            proof.request_saved = true;
            proof.delivery_status = saved.data.delivery_status;
            proof.notification_queued = saved.data.notification_queued === true;
            proof.delivery_recorded = saved.data.delivery_status !== "pending"
              && saved.data.delivery_status !== "queued";

            // Compatibility path for in-memory/test/legacy repositories. Production
            // Supabase reports notification_queued=true and never sends inline.
            if (!saved.data.notification_queued && saved.data.created) {
              const base: AdminNotificationResult = {
                type: "admin_notification",
                status: "not_configured",
                channel: "telegram",
                reason: request.kind,
                trace_id: input.trace_id,
              };
              delivery = deps.adminNotifier
                ? await deps.adminNotifier.notify({
                    ...notificationContext,
                    staff_request: { ...request, request_id: saved.data.request_id },
                  }).catch(() => ({ ...base, status: "failed" as const, error_code: "staff_notification_exception" }))
                : base;
              proof.delivery_status = delivery.status;
              const recorded = await repository.recordDelivery({
                clinic_id: input.clinic_id,
                contact_id: input.contact_id,
                request_id: saved.data.request_id,
                delivery,
              }).catch(() => null);
              proof.delivery_recorded = recorded?.ok === true;
            }
          }
        }

        // Durable queueing is not delivery. Only a persisted/synchronous sent status permits the claim.
        proof.may_claim_notified = proof.request_saved && proof.delivery_status === "sent";
        const additionalReply = sanitizeStaffAdditionalReply(request.additional_reply);
        const additionalReplySuppressed = Boolean(request.additional_reply && !additionalReply);
        return {
          ...result,
          final_patient_reply: [staffRequestReceipt(request, proof), additionalReply].filter(Boolean).join("\n\n"),
          staff_request_state: { request, proof },
          side_effects: [...(result.side_effects ?? []), proof, ...(delivery ? [delivery] : [])],
          debug: {
            ...result.debug,
            staff_request: {
              ...proof,
              stable_inbound_identifier: idempotencyKey !== null,
              ...(additionalReplySuppressed ? { additional_reply_suppressed: true } : {}),
            },
          },
        };
      },
    },
  };
}

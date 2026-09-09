import type { RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestratorLegacy.ts";
import type { AdminNotificationResult } from "../integrations/adminNotify/adminNotifyTypes.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import {
  parseStaffRequest,
  sanitizeStaffAdditionalReply,
  staffRequestFailureReceipt,
  staffRequestReceipt,
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

/**
 * The agent proposes one staff request; Runtime persists it before any notification.
 * This runs inside the shared inbound dedupe/serialization boundary, before the final
 * reply is stored or sent. Neither the model nor transport adapters execute the write.
 */
export function withStaffRequestHandling(deps: RuntimeTurnOrchestratorDeps): RuntimeTurnOrchestratorDeps {
  return {
    ...deps,
    runtimeTurnService: {
      async runTurn(input) {
        const result = await deps.runtimeTurnService.runTurn(input);
        if (!isAgentFirstRuntimeEnabled()) return result;

        // A malformed side-effect proposal is not an ordinary reply. Never let the
        // model's success prose escape when Runtime could not validate an executable request.
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
        // channels or from a model-only claim. Voice must persist the request first, then
        // the voice gateway may act on the resulting saved side-effect proof.
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

        // Staff notification is an externally visible side effect. A random Runtime trace
        // is not an idempotency key. The durable request uses the stable provider event key;
        // the ordinary Runtime trace remains attached to notification/audit delivery data.
        if (repository && input.contact_id && input.trace_id && idempotencyKey) {
          const saved = await repository.create({
            clinic_id: input.clinic_id,
            contact_id: input.contact_id,
            trace_id: idempotencyKey,
            request,
            source_message: input.user_message,
          }).catch(() => null);
          if (saved?.ok) {
            proof.request_id = saved.data.request_id;
            proof.request_saved = true;
            proof.delivery_status = saved.data.delivery_status;
            proof.delivery_recorded = saved.data.delivery_status !== "pending";

            // Only the transaction that created the durable request owns delivery.
            // A duplicate or crash after creation must not silently send again.
            if (saved.data.created) {
              const base: AdminNotificationResult = {
                type: "admin_notification",
                status: "not_configured",
                channel: "telegram",
                reason: request.kind,
                trace_id: input.trace_id,
              };
              delivery = deps.adminNotifier
                ? await deps.adminNotifier.notify({
                    clinic_id: input.clinic_id,
                    clinic_code: value(context?.clinic_code),
                    channel,
                    chat_id: value(context?.chat_id),
                    external_user_id: value(context?.external_user_id),
                    trace_id: input.trace_id,
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

        // Queueing is not delivery; a doctor's call/review is never promised here.
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

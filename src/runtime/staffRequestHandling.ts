import type { RuntimeTurnOrchestratorDeps } from "./runtimeTurnOrchestratorLegacy.ts";
import type { AdminNotificationResult } from "../integrations/adminNotify/adminNotifyTypes.ts";
import { isAgentFirstRuntimeEnabled } from "./agentFirstRuntimePolicy.ts";
import { parseStaffRequest, staffRequestReceipt, type StaffRequestProof } from "./staffRequest.ts";

function value(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
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
        const request = parseStaffRequest(result.staff_request);
        if (!request) return result;

        const proof: StaffRequestProof = {
          type: "staff_request",
          request_id: null,
          request_saved: false,
          delivery_status: "failed",
          delivery_recorded: false,
          may_claim_notified: false,
        };
        let delivery: AdminNotificationResult | null = null;
        const repository = deps.staffRequestRepository;
        if (repository && input.contact_id && input.trace_id) {
          const saved = await repository.create({
            clinic_id: input.clinic_id,
            contact_id: input.contact_id,
            trace_id: input.trace_id,
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
              const context = input.business_context;
              delivery = deps.adminNotifier
                ? await deps.adminNotifier.notify({
                    clinic_id: input.clinic_id,
                    clinic_code: value(context?.clinic_code),
                    channel: value(context?.channel) ?? "unknown",
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
        return {
          ...result,
          final_patient_reply: [staffRequestReceipt(request, proof), request.additional_reply].filter(Boolean).join("\n\n"),
          staff_request_state: { request, proof },
          side_effects: [...(result.side_effects ?? []), proof, ...(delivery ? [delivery] : [])],
          debug: { ...result.debug, staff_request: proof },
        };
      },
    },
  };
}

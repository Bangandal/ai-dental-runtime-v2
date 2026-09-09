import type { RuntimeTurnService } from "./runtimeTurnService.ts";
import type { AdminNotifier } from "../integrations/adminNotify/adminNotifyTypes.ts";
import {
  parseStaffRequest,
  sanitizeStaffAdditionalReply,
  staffRequestFailureReceipt,
  staffRequestReceipt,
  type StaffRequestProof,
  type StaffRequestRepository,
} from "./staffRequest.ts";
import { executeStaffRequestAuthority } from "./staffRequestAuthority.ts";

export interface StaffRequestHandlingDeps {
  runtimeTurnService: RuntimeTurnService;
  staffRequestRepository?: StaffRequestRepository;
  adminNotifier?: AdminNotifier;
}

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
 * Model adapter only. Parsing and patient-facing receipts live here; durable staff authority
 * is shared with voice through executeStaffRequestAuthority().
 */
export function withStaffRequestHandling<T extends StaffRequestHandlingDeps>(deps: T): T {
  return {
    ...deps,
    runtimeTurnService: {
      async runTurn(input) {
        const result = await deps.runtimeTurnService.runTurn(input);

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
        const idempotencyKey = stableStaffRequestKey(context);
        const authority = await executeStaffRequestAuthority({
          clinic_id: input.clinic_id,
          clinic_code: value(context?.clinic_code),
          contact_id: input.contact_id ?? null,
          trace_id: input.trace_id ?? "unknown",
          idempotency_key: idempotencyKey,
          channel,
          chat_id: value(context?.chat_id),
          external_user_id: value(context?.external_user_id),
          source_message: input.user_message,
          request,
          channel_contact: input.channel_contact ?? null,
          repository: deps.staffRequestRepository,
          adminNotifier: deps.adminNotifier,
        });

        const proof = authority.proof;
        const additionalReply = sanitizeStaffAdditionalReply(request.additional_reply);
        const additionalReplySuppressed = Boolean(request.additional_reply && !additionalReply);
        const channelViolation = request.kind === "live_transfer" && channel !== "voice";

        return {
          ...result,
          final_patient_reply: channelViolation
            ? staffRequestFailureReceipt(request.reply_language)
            : [staffRequestReceipt(request, proof), additionalReply].filter(Boolean).join("\n\n"),
          staff_request_state: { request, proof },
          side_effects: [
            ...(result.side_effects ?? []),
            proof,
            ...(authority.delivery ? [authority.delivery] : []),
          ],
          debug: {
            ...result.debug,
            staff_request: {
              ...proof,
              stable_inbound_identifier: idempotencyKey !== null,
              ...(channelViolation ? { reason: "live_transfer_requires_voice" } : {}),
              ...(additionalReplySuppressed ? { additional_reply_suppressed: true } : {}),
            },
          },
        };
      },
    },
  };
}

import type {
  AdminNotificationPayload,
  AdminNotificationResult,
} from "../integrations/adminNotify/adminNotifyTypes.ts";
import type { RpcCaller, RuntimeResult } from "./runtimeRepositories.ts";
import type { StaffNotificationContext, StaffRequest } from "./staffRequest.ts";

export interface StaffNotificationOutboxItem {
  outbox_id: string;
  request_id: string;
  clinic_id: string;
  contact_id: string;
  request: StaffRequest;
  notification_context: StaffNotificationContext;
  attempt_count: number;
}

export interface StaffNotificationOutboxRepository {
  claim(input: { limit: number }): Promise<RuntimeResult<StaffNotificationOutboxItem[]>>;
  complete(input: {
    outbox_id: string;
    request_id: string;
    delivery: AdminNotificationResult;
    retry_after_seconds: number | null;
    terminal: boolean;
  }): Promise<RuntimeResult<{ ok: true }>>;
}

function fail<T>(code: string, retryable = false): RuntimeResult<T> {
  return { ok: false, error: { code, message: "Staff notification outbox operation failed", retryable } };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseItem(raw: unknown): StaffNotificationOutboxItem | null {
  const row = record(raw);
  const request = record(row?.request);
  const context = record(row?.notification_context);
  if (!row || !request || !context) return null;
  if (typeof row.outbox_id !== "string" || typeof row.request_id !== "string"
    || typeof row.clinic_id !== "string" || typeof row.contact_id !== "string"
    || typeof row.attempt_count !== "number" || row.attempt_count < 1) return null;
  if (!["callback", "document_update", "live_transfer"].includes(String(request.kind))) return null;
  if (!["self", "other_person"].includes(String(request.patient_target))) return null;
  if (!["uk", "ru", "cs", "en"].includes(String(request.reply_language))) return null;
  if (typeof request.person_ref !== "string" || typeof request.summary !== "string") return null;
  if (typeof context.clinic_id !== "string" || typeof context.channel !== "string"
    || typeof context.trace_id !== "string" || typeof context.reason !== "string") return null;
  return {
    outbox_id: row.outbox_id,
    request_id: row.request_id,
    clinic_id: row.clinic_id,
    contact_id: row.contact_id,
    request: request as unknown as StaffRequest,
    notification_context: context as unknown as StaffNotificationContext,
    attempt_count: row.attempt_count,
  };
}

export function buildStaffNotificationPayload(item: StaffNotificationOutboxItem): AdminNotificationPayload {
  return {
    ...item.notification_context,
    staff_request: {
      ...item.request,
      request_id: item.request_id,
    },
  };
}

export function createSupabaseStaffNotificationOutboxRepository(
  deps: { rpc: RpcCaller },
): StaffNotificationOutboxRepository {
  return {
    async claim(input) {
      const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)));
      const { data, error } = await deps.rpc<unknown>("rpc_claim_staff_notification_outbox", {
        p_limit: limit,
      });
      if (error || !Array.isArray(data)) return fail("staff_notification_outbox_claim_failed", true);
      const items: StaffNotificationOutboxItem[] = [];
      for (const raw of data) {
        const parsed = parseItem(raw);
        if (!parsed) return fail("staff_notification_outbox_claim_invalid");
        items.push(parsed);
      }
      return { ok: true, data: items };
    },

    async complete(input) {
      const { data, error } = await deps.rpc<unknown>("rpc_complete_staff_notification_outbox", {
        p_outbox_id: input.outbox_id,
        p_request_id: input.request_id,
        p_delivery: input.delivery,
        p_retry_after_seconds: input.retry_after_seconds,
        p_terminal: input.terminal,
      });
      if (error || !Array.isArray(data) || data[0]?.ok !== true) {
        return fail("staff_notification_outbox_complete_failed", true);
      }
      return { ok: true, data: { ok: true } };
    },
  };
}

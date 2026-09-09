import type { RpcCaller, RuntimeResult } from "./runtimeRepositories.ts";
import type { StaffRequest } from "./staffRequest.ts";

export type StaffRequestWorkflowStatus = "open" | "acknowledged" | "resolved";

export interface StaffInboxItem {
  request_id: string;
  clinic_id: string;
  contact_id: string;
  request: StaffRequest;
  delivery_status: "pending" | "sent" | "queued" | "failed" | "disabled" | "not_configured";
  workflow_status: StaffRequestWorkflowStatus;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface StaffOpsMetrics {
  open_requests: number;
  acknowledged_requests: number;
  queued_notifications: number;
  processing_notifications: number;
  dead_letter_notifications: number;
  oldest_queued_age_seconds: number | null;
}

export interface StaffInboxRepository {
  list(input: {
    clinic_id: string;
    status?: StaffRequestWorkflowStatus | "all";
    limit?: number;
  }): Promise<RuntimeResult<StaffInboxItem[]>>;
  setStatus(input: {
    clinic_id: string;
    request_id: string;
    status: StaffRequestWorkflowStatus;
    resolution_note?: string | null;
  }): Promise<RuntimeResult<StaffInboxItem>>;
  metrics(input: { clinic_id?: string | null }): Promise<RuntimeResult<StaffOpsMetrics>>;
}

function fail<T>(code: string, retryable = false): RuntimeResult<T> {
  return { ok: false, error: { code, message: "Staff inbox operation failed", retryable } };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseRequest(raw: unknown): StaffRequest | null {
  const value = record(raw);
  if (!value) return null;
  if (!["callback", "document_update", "live_transfer"].includes(String(value.kind))) return null;
  if (!["self", "other_person"].includes(String(value.patient_target))) return null;
  if (!["uk", "ru", "cs", "en"].includes(String(value.reply_language))) return null;
  if (typeof value.person_ref !== "string" || typeof value.summary !== "string") return null;
  return value as unknown as StaffRequest;
}

function parseItem(raw: unknown): StaffInboxItem | null {
  const row = record(raw);
  if (!row) return null;
  const request = parseRequest(row.request);
  if (!request) return null;
  if (typeof row.request_id !== "string" || typeof row.clinic_id !== "string" || typeof row.contact_id !== "string") return null;
  if (!["pending", "sent", "queued", "failed", "disabled", "not_configured"].includes(String(row.delivery_status))) return null;
  if (!["open", "acknowledged", "resolved"].includes(String(row.workflow_status))) return null;
  if (typeof row.created_at !== "string" || typeof row.updated_at !== "string") return null;
  if (row.resolution_note !== null && row.resolution_note !== undefined && typeof row.resolution_note !== "string") return null;
  if (row.resolved_at !== null && row.resolved_at !== undefined && typeof row.resolved_at !== "string") return null;
  return {
    request_id: row.request_id,
    clinic_id: row.clinic_id,
    contact_id: row.contact_id,
    request,
    delivery_status: row.delivery_status as StaffInboxItem["delivery_status"],
    workflow_status: row.workflow_status as StaffRequestWorkflowStatus,
    resolution_note: typeof row.resolution_note === "string" ? row.resolution_note : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: typeof row.resolved_at === "string" ? row.resolved_at : null,
  };
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function createSupabaseStaffInboxRepository(deps: { rpc: RpcCaller }): StaffInboxRepository {
  return {
    async list(input) {
      const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
      const { data, error } = await deps.rpc<unknown>("rpc_list_staff_requests", {
        p_clinic_id: input.clinic_id,
        p_status: input.status && input.status !== "all" ? input.status : null,
        p_limit: limit,
      });
      if (error || !Array.isArray(data)) return fail("staff_inbox_list_failed", true);
      const items: StaffInboxItem[] = [];
      for (const row of data) {
        const item = parseItem(row);
        if (!item) return fail("staff_inbox_item_invalid");
        items.push(item);
      }
      return { ok: true, data: items };
    },

    async setStatus(input) {
      const note = input.resolution_note?.trim() || null;
      if (note && note.length > 1000) return fail("staff_inbox_resolution_note_invalid");
      const { data, error } = await deps.rpc<unknown>("rpc_update_staff_request_status", {
        p_clinic_id: input.clinic_id,
        p_request_id: input.request_id,
        p_status: input.status,
        p_resolution_note: note,
      });
      const row = Array.isArray(data) ? data[0] : null;
      const item = parseItem(row);
      if (error || !item) return fail("staff_inbox_status_update_failed", true);
      return { ok: true, data: item };
    },

    async metrics(input) {
      const { data, error } = await deps.rpc<unknown>("rpc_staff_ops_metrics", {
        p_clinic_id: input.clinic_id ?? null,
      });
      const row = Array.isArray(data) ? record(data[0]) : null;
      if (error || !row) return fail("staff_ops_metrics_failed", true);
      const open = finiteCount(row.open_requests);
      const acknowledged = finiteCount(row.acknowledged_requests);
      const queued = finiteCount(row.queued_notifications);
      const processing = finiteCount(row.processing_notifications);
      const dead = finiteCount(row.dead_letter_notifications);
      const oldest = row.oldest_queued_age_seconds == null ? null : finiteCount(row.oldest_queued_age_seconds);
      if (open == null || acknowledged == null || queued == null || processing == null || dead == null
        || (row.oldest_queued_age_seconds != null && oldest == null)) {
        return fail("staff_ops_metrics_invalid");
      }
      return { ok: true, data: {
        open_requests: open,
        acknowledged_requests: acknowledged,
        queued_notifications: queued,
        processing_notifications: processing,
        dead_letter_notifications: dead,
        oldest_queued_age_seconds: oldest,
      } };
    },
  };
}

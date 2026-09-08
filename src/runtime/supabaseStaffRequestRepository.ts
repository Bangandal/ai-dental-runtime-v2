import type { RpcCaller, RuntimeResult } from "./runtimeRepositories.ts";
import type { StaffRequestRecord, StaffRequestRepository } from "./staffRequest.ts";

const DELIVERY_STATUSES = new Set(["pending", "sent", "queued", "failed", "disabled", "not_configured"]);

function fail<T>(code: string): RuntimeResult<T> {
  return { ok: false, error: { code, message: "Staff request persistence failed", retryable: false } };
}

export function createSupabaseStaffRequestRepository(deps: { rpc: RpcCaller }): StaffRequestRepository {
  return {
    async create(input) {
      const { data, error } = await deps.rpc<unknown>("rpc_create_staff_request", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_trace_id: input.trace_id,
        p_request: input.request,
        p_source_message: input.source_message,
      });
      if (error) return fail("staff_request_persist_failed");
      const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
      if (!row || typeof row.request_id !== "string" || !row.request_id
        || typeof row.created !== "boolean" || !DELIVERY_STATUSES.has(String(row.delivery_status))) {
        return fail("staff_request_proof_invalid");
      }
      return { ok: true, data: {
        request_id: row.request_id,
        created: row.created,
        delivery_status: row.delivery_status as StaffRequestRecord["delivery_status"],
      } };
    },
    async recordDelivery(input) {
      const { data, error } = await deps.rpc<unknown>("rpc_record_staff_request_delivery", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_request_id: input.request_id,
        p_delivery: input.delivery,
      });
      if (error || !Array.isArray(data) || data[0]?.ok !== true) {
        return fail("staff_request_delivery_persist_failed");
      }
      return { ok: true, data: { ok: true } };
    },
  };
}

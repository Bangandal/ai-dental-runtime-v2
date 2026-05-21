import type { BookingRepository, RpcAvailabilitySlot, RuntimeResult } from "./runtimeRepositories.ts";

export type RpcCaller = <TResult>(
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: TResult | null; error: unknown | null }>;

interface RpcAvailabilityRow {
  slot_key?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
  doctor_id?: unknown;
  timezone?: unknown;
}

function malformedResponse(details?: Record<string, unknown>): RuntimeResult<{ slots: RpcAvailabilitySlot[]; timezone?: string | null }> {
  return {
    ok: false,
    error: {
      code: "availability_rpc_malformed_response",
      message: "Availability RPC returned malformed rows",
      retryable: false,
      details,
    },
  };
}

function normalizeSlot(row: RpcAvailabilityRow, index: number): RuntimeResult<RpcAvailabilitySlot, "availability_rpc_malformed_response"> {
  if (typeof row.slot_key !== "string" || typeof row.starts_at !== "string" || typeof row.ends_at !== "string") {
    return {
      ok: false,
      error: {
        code: "availability_rpc_malformed_response",
        message: "Availability row missing required fields",
        retryable: false,
        details: { index },
      },
    };
  }

  return {
    ok: true,
    data: {
      slot_id: row.slot_key,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      provider_id: typeof row.doctor_id === "string" ? row.doctor_id : null,
      service_id: null,
      timezone: typeof row.timezone === "string" ? row.timezone : null,
    },
  };
}

export function createSupabaseAvailabilityRepository(deps: { rpc: RpcCaller }): Pick<BookingRepository, "checkAvailability"> {
  return {
    async checkAvailability(input) {
      const response = await deps.rpc<RpcAvailabilityRow[]>("core.rpc_check_availability_v1", {
        p_clinic_id: input.clinic_id,
        p_service_interest: input.service_interest ?? null,
        p_requested_date: input.requested_date,
        p_requested_time: input.requested_time ?? null,
        p_timezone: input.timezone ?? null,
        p_limit: input.limit ?? null,
      });

      if (response.error) {
        return {
          ok: false,
          error: {
            code: "availability_rpc_error",
            message: "Failed to check availability via RPC",
            retryable: true,
            details: { rpc: "core.rpc_check_availability_v1" },
          },
        };
      }

      if (response.data == null) {
        return { ok: true, data: { slots: [] } };
      }

      if (!Array.isArray(response.data)) {
        return malformedResponse({ reason: "response_not_array" });
      }

      const slots: RpcAvailabilitySlot[] = [];
      for (const [index, row] of response.data.entries()) {
        const normalized = normalizeSlot(row, index);
        if (!normalized.ok) {
          return malformedResponse({ index });
        }
        slots.push(normalized.data);
      }

      return {
        ok: true,
        data: {
          slots,
          timezone: slots[0]?.timezone ?? input.timezone ?? null,
        },
      };
    },
  };
}

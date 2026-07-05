import type { RpcCaller } from "./runtimeRepositories.ts";
import type { BookingProcessState, BookingProcessStateRepository } from "./bookingProcessState.ts";

interface BookingProcessStateRow {
  state?: unknown;
}

export function createSupabaseBookingProcessStateRepository(deps: { rpc: RpcCaller }): BookingProcessStateRepository {
  return {
    async loadState(key) {
      if (!key.contact_id) return null;
      try {
        const result = await deps.rpc<BookingProcessStateRow[]>(
          "rpc_get_booking_process_state_v1",
          {
            p_clinic_id: key.clinic_id,
            p_contact_id: key.contact_id,
          },
        );
        if (result.error || !Array.isArray(result.data) || result.data.length === 0) return null;
        const raw = result.data[0]?.state;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        return raw as Partial<BookingProcessState>;
      } catch {
        return null;
      }
    },

    async saveState(key, state) {
      if (!key.contact_id) return;
      try {
        await deps.rpc<unknown>("rpc_upsert_booking_process_state_v1", {
          p_clinic_id: key.clinic_id,
          p_contact_id: key.contact_id,
          p_state: state,
        });
      } catch {
        // best-effort — state loss only affects field-memory hints, not safety
      }
    },
  };
}

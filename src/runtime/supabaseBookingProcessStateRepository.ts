import type { RpcCaller } from "./runtimeRepositories.ts";
import type { BookingProcessState, BookingProcessStateRepository } from "./bookingProcessState.ts";
import { sanitizeErrorMessage } from "./callerExceptionDiagnostics.ts";

interface BookingProcessStateRow {
  state?: unknown;
}

export function createSupabaseBookingProcessStateRepository(deps: { rpc: RpcCaller }): BookingProcessStateRepository {
  return {
    async loadState(key, onDebug) {
      if (!key.contact_id) {
        onDebug?.({ loaded: false, reason: "null_or_missing" });
        return null;
      }
      try {
        const result = await deps.rpc<BookingProcessStateRow[]>(
          "rpc_get_booking_process_state_v1",
          {
            p_clinic_id: key.clinic_id,
            p_contact_id: key.contact_id,
          },
        );
        if (result.error) {
          onDebug?.({
            loaded: false,
            reason: "rpc_error",
            error: sanitizeErrorMessage(
              typeof (result.error as { message?: string }).message === "string"
                ? (result.error as { message: string }).message
                : String(result.error),
            ),
          });
          return null;
        }
        if (!Array.isArray(result.data) || result.data.length === 0) {
          onDebug?.({ loaded: false, reason: "null_or_missing" });
          return null;
        }
        const raw = result.data[0]?.state;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          onDebug?.({ loaded: false, reason: "null_or_missing" });
          return null;
        }
        onDebug?.({ loaded: true });
        return raw as Partial<BookingProcessState>;
      } catch (err) {
        onDebug?.({
          loaded: false,
          reason: "rpc_error",
          error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        });
        return null;
      }
    },

    async saveState(key, state, onDebug) {
      if (!key.contact_id) return;
      try {
        const result = await deps.rpc<unknown>("rpc_upsert_booking_process_state_v1", {
          p_clinic_id: key.clinic_id,
          p_contact_id: key.contact_id,
          p_state: state,
        });
        if (result.error) {
          onDebug?.({
            saved: false,
            error: sanitizeErrorMessage(
              typeof (result.error as { message?: string }).message === "string"
                ? (result.error as { message: string }).message
                : String(result.error),
            ),
          });
          return;
        }
        onDebug?.({ saved: true });
      } catch (err) {
        onDebug?.({
          saved: false,
          error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        });
        // best-effort — state loss only affects field-memory hints, not safety
      }
    },
  };
}

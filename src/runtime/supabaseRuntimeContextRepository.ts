import type { RuntimeResult, RpcCaller } from "./runtimeRepositories.ts";

export interface RuntimeContext {
  known_contact: Record<string, unknown>;
  conversation_state: Record<string, unknown>;
  runtime_flags: {
    has_durable_context: boolean;
    context_source: "supabase";
    context_loaded_at: string;
  };
  recent_history: unknown[];
}

export interface RuntimeContextRepository {
  loadRuntimeContext(input: { clinic_id: string; contact_id: string }): Promise<RuntimeResult<RuntimeContext>>;
}

interface RuntimeContextRpcRow {
  known_contact?: Record<string, unknown> | null;
  conversation_state?: Record<string, unknown> | null;
  recent_history?: unknown[] | null;
}

export function createSupabaseRuntimeContextRepository(deps: { rpc: RpcCaller }): RuntimeContextRepository {
  return {
    async loadRuntimeContext(input) {
      const loadedAt = new Date().toISOString();
      const response = await deps.rpc<RuntimeContextRpcRow[]>("rpc_get_runtime_context", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
      });

      if (response.error) {
        return {
          ok: false,
          error: { code: "runtime_context_load_failed", message: String((response.error as { message?: unknown })?.message ?? response.error), retryable: true },
        };
      }

      const row = Array.isArray(response.data) ? response.data[0] : null;
      const knownContact = row?.known_contact ?? { contact_id: input.contact_id, clinic_id: input.clinic_id };
      const conversationState = row?.conversation_state ?? {};

      return {
        ok: true,
        data: {
          known_contact: knownContact,
          conversation_state: conversationState,
          runtime_flags: {
            has_durable_context: Boolean(row),
            context_source: "supabase",
            context_loaded_at: loadedAt,
          },
          recent_history: [],
        },
      };
    },
  };
}

import type { RuntimeResult, RpcCaller } from "./runtimeRepositories.ts";

export interface RuntimeContext {
  known_contact: Record<string, unknown>;
  conversation_state: Record<string, unknown>;
  runtime_flags: {
    has_durable_context: boolean;
    context_source: "supabase";
    context_loaded_at: string;
    available_recent_history_count?: number;
  };
  recent_history: unknown[];
}

export interface RuntimeContextRepository {
  loadRuntimeContext(input: { clinic_id: string; contact_id: string }): Promise<RuntimeResult<RuntimeContext>>;
}

interface RuntimeContextRpcRow {
  out_state_json?: Record<string, unknown> | null;
  out_state_version?: number | null;
  out_recent_messages?: unknown[] | string | null;
  out_contact_meta?: Record<string, unknown> | string | null;
  out_collected?: Record<string, unknown> | string | null;
  out_missing_fields?: unknown[] | string | null;
  out_need_admin?: boolean | null;
  out_last_intent?: string | null;
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
      const stateJson = asRecord(parseMaybeJson(row?.out_state_json));
      const contactMeta = asRecord(parseMaybeJson(row?.out_contact_meta));
      const collected = asRecord(parseMaybeJson(row?.out_collected)) ?? asRecord(stateJson?.collected) ?? {};
      const missingFields = asArray(parseMaybeJson(row?.out_missing_fields)) ?? asArray(stateJson?.missing_fields) ?? [];
      const recentMessages = asArray(parseMaybeJson(row?.out_recent_messages)) ?? [];

      const knownContact: Record<string, unknown> = {
        contact_id: input.contact_id,
        clinic_id: input.clinic_id,
        chat_id: contactMeta?.chat_id ?? null,
        external_user_id: contactMeta?.external_user_id ?? null,
        username: contactMeta?.username ?? null,
        first_name: contactMeta?.first_name ?? null,
        last_name: contactMeta?.last_name ?? null,
        phone: contactMeta?.phone ?? null,
        language_code: contactMeta?.language_code ?? null,
      };

      const conversationState: Record<string, unknown> = {
        state_version: row?.out_state_version ?? 0,
        collected,
        missing_fields: missingFields,
        last_bot_action: stateJson?.last_bot_action ?? null,
        last_bot_question: stateJson?.last_bot_question ?? null,
        pending_slots: asStringArray(stateJson?.pending_slots),
        last_user_message_text: stateJson?.last_user_message_text ?? null,
        intent: row?.out_last_intent ?? stateJson?.intent ?? "unknown",
        qualification_stage: stateJson?.qualification_stage ?? null,
        conversation_stage: stateJson?.conversation_stage ?? null,
        turn_count: typeof stateJson?.turn_count === "number" ? stateJson.turn_count : 0,
        need_admin: row?.out_need_admin ?? false,
      };

      return {
        ok: true,
        data: {
          known_contact: knownContact,
          conversation_state: conversationState,
          runtime_flags: {
            has_durable_context: Boolean(row),
            context_source: "supabase",
            context_loaded_at: loadedAt,
            available_recent_history_count: recentMessages.length,
          },
          recent_history: [],
        },
      };
    },
  };
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

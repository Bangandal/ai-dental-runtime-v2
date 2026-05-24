import type { RpcCaller } from "./runtimeRepositories.ts";
import type { RuntimeResult } from "./runtimeRepositories.ts";

export interface TurnPersistenceRepository {
  getOrCreateContact(input: {
    clinic_id: string;
    channel: string;
    external_user_id?: string | null;
    chat_id?: string | null;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  }): Promise<RuntimeResult<{ contact_id: string }>>;
  registerInboundEvent(input: {
    clinic_id: string;
    contact_id: string;
    channel: string;
    external_user_id?: string | null;
    chat_id?: string | null;
    trace_id: string;
    raw_payload?: Record<string, unknown> | null;
  }): Promise<RuntimeResult<{ inbound_event_id?: string | null }>>;
  saveMessage(input: {
    clinic_id: string;
    contact_id: string;
    role: "user" | "assistant";
    text: string;
    trace_id: string;
  }): Promise<RuntimeResult<{ message_id?: string | null }>>;
  mergeConversationState(input: {
    clinic_id: string;
    contact_id: string;
    patch: Record<string, unknown>;
  }): Promise<RuntimeResult<{ ok: true }>>;
}

export function createSupabaseTurnPersistenceRepository(deps: { rpc: RpcCaller }): TurnPersistenceRepository {
  return {
    async getOrCreateContact(input) {
      const { data, error } = await deps.rpc<Array<{ contact_id?: unknown }>>("rpc_get_or_create_contact", {
        p_clinic_id: input.clinic_id,
        p_channel: input.channel,
        p_external_user_id: input.external_user_id ?? null,
        p_chat_id: input.chat_id ?? null,
        p_username: input.username ?? null,
        p_first_name: input.first_name ?? null,
        p_last_name: input.last_name ?? null,
      });
      if (error) return fail("contact_persist_failed", "Failed to get/create contact");
      const contactId = typeof data?.[0]?.contact_id === "string" ? data[0].contact_id : null;
      if (!contactId) return fail("contact_persist_invalid", "Contact RPC returned empty contact_id", false);
      return { ok: true, data: { contact_id: contactId } };
    },
    async registerInboundEvent(input) {
      const { data, error } = await deps.rpc<Array<{ inbound_event_id?: unknown }>>("rpc_register_inbound_event", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_channel: input.channel,
        p_external_user_id: input.external_user_id ?? null,
        p_chat_id: input.chat_id ?? null,
        p_trace_id: input.trace_id,
        p_raw_payload: input.raw_payload ?? null,
      });
      if (error) return fail("inbound_event_persist_failed", "Failed to register inbound event");
      return { ok: true, data: { inbound_event_id: typeof data?.[0]?.inbound_event_id === "string" ? data[0].inbound_event_id : null } };
    },
    async saveMessage(input) {
      const { data, error } = await deps.rpc<Array<{ message_id?: unknown }>>("rpc_save_message", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_role: input.role,
        p_text: input.text,
        p_trace_id: input.trace_id,
      });
      if (error) return fail("message_persist_failed", "Failed to save message");
      return { ok: true, data: { message_id: typeof data?.[0]?.message_id === "string" ? data[0].message_id : null } };
    },
    async mergeConversationState(input) {
      const { error } = await deps.rpc<unknown>("rpc_merge_conversation_state", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_patch: input.patch,
      });
      if (error) return fail("convo_state_persist_failed", "Failed to merge conversation state");
      return { ok: true, data: { ok: true } };
    },
  };
}

function fail(code: string, message: string, retryable = true): RuntimeResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

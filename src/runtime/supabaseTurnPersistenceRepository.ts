import type { RpcCaller } from "./runtimeRepositories.ts";
import type { RuntimeResult } from "./runtimeRepositories.ts";
import type { TopicMemoryStatePatch } from "./topicMemoryCandidateShadow.ts";
import type { RuntimeCaseLite } from "./runtimeCaseLite.ts";

export interface TurnPersistenceRepository {
  getOrCreateContact(input: {
    clinic_code: string;
    channel: string;
    external_user_id?: string | null;
    chat_id?: string | null;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  }): Promise<RuntimeResult<{ contact_id: string; clinic_id?: string }>>;
  registerInboundEvent(input: {
    clinic_id: string;
    contact_id: string;
    channel: string;
    external_user_id?: string | null;
    dedupe_key: string;
    source_message_id: string;
    source_update_id: string;
    payload: Record<string, unknown>;
    trace_id: string;
    n8n_execution_id?: string | null;
  }): Promise<RuntimeResult<{ inbound_event_id?: string | null }>>;
  saveMessage(input: {
    contact_id: string;
    direction: "inbound" | "outbound";
    role: "user" | "assistant";
    channel: string;
    text: string;
    message_type: string;
    status: string;
    provider_message_id: string;
    reply_to_message_id?: string | null;
    meta: Record<string, unknown>;
  }): Promise<RuntimeResult<{ message_id?: string | null }>>;
  mergeConversationState(input: {
    clinic_id: string;
    contact_id: string;
    user_text: string;
    reply_text: string;
    requested_action: string;
    conversation_intent: string;
    handoff_recommended: boolean;
    confidence: string;
    control_flags: Record<string, unknown>;
    topic_memory_patch?: TopicMemoryStatePatch | null;
    case_context_lite?: RuntimeCaseLite | null;
  }): Promise<RuntimeResult<{ ok: true }>>;
}

export function createSupabaseTurnPersistenceRepository(deps: { rpc: RpcCaller }): TurnPersistenceRepository {
  return {
    async getOrCreateContact(input) {
      const { data, error } = await deps.rpc<Array<{ contact_id?: unknown; clinic_id?: unknown }>>("rpc_get_or_create_contact", {
        p_clinic_code: input.clinic_code,
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
      const clinicId = typeof data?.[0]?.clinic_id === "string" ? data[0].clinic_id : undefined;
      return { ok: true, data: { contact_id: contactId, clinic_id: clinicId } };
    },
    async registerInboundEvent(input) {
      const { data, error } = await deps.rpc<Array<{ inbound_event_id?: unknown }>>("rpc_register_inbound_event", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_channel: input.channel,
        p_external_user_id: input.external_user_id ?? null,
        p_dedupe_key: input.dedupe_key,
        p_source_message_id: input.source_message_id,
        p_source_update_id: input.source_update_id,
        p_payload: input.payload,
        p_trace_id: input.trace_id,
        p_n8n_execution_id: input.n8n_execution_id ?? null,
      });
      if (error) return fail("inbound_event_persist_failed", "Failed to register inbound event");
      return { ok: true, data: { inbound_event_id: typeof data?.[0]?.inbound_event_id === "string" ? data[0].inbound_event_id : null } };
    },
    async saveMessage(input) {
      const { data, error } = await deps.rpc<Array<{ message_id?: unknown }>>("rpc_save_message", {
        p_contact_id: input.contact_id,
        p_direction: input.direction,
        p_role: input.role,
        p_channel: input.channel,
        p_text: input.text,
        p_message_type: input.message_type,
        p_status: input.status,
        p_provider_message_id: input.provider_message_id,
        p_reply_to_message_id: input.reply_to_message_id ?? null,
        p_meta: input.meta,
      });
      if (error) return fail("message_persist_failed", "Failed to save message");
      return { ok: true, data: { message_id: typeof data?.[0]?.message_id === "string" ? data[0].message_id : null } };
    },
    async mergeConversationState(input) {
      const { error } = await deps.rpc<unknown>("rpc_merge_conversation_state", {
        p_clinic_id: input.clinic_id,
        p_contact_id: input.contact_id,
        p_user_text: input.user_text,
        p_reply_text: input.reply_text,
        p_slot_updates: {},
        p_requested_action: input.requested_action,
        p_conversation_intent: input.conversation_intent,
        p_handoff_recommended: input.handoff_recommended,
        p_confidence: input.confidence,
        p_control_flags: {
          ...input.control_flags,
          ...(input.topic_memory_patch ?? {}),
          ...(input.case_context_lite != null ? { case_context_lite: input.case_context_lite } : {}),
        },
      });
      if (error) return fail("convo_state_persist_failed", "Failed to merge conversation state");
      return { ok: true, data: { ok: true } };
    },
  };
}

function fail(code: string, message: string, retryable = true): RuntimeResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

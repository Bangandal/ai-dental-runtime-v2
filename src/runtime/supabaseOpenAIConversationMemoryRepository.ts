import type { RuntimeResult } from "./runtimeRepositories.ts";

export type RpcCaller = <TResult>(
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: TResult | null; error: unknown | null }>;

interface ConversationMemoryRpcRow {
  conversation_id?: unknown;
}

export interface OpenAIConversationMemoryRepository {
  getConversationMemory(input: {
    clinic_id: string;
    channel: string;
    external_user_id?: string | null;
    chat_id?: string | null;
  }): Promise<RuntimeResult<{ conversation_id: string | null }>>;

  saveConversationMemory(input: {
    clinic_id: string;
    channel: string;
    external_user_id?: string | null;
    chat_id?: string | null;
    conversation_id: string;
  }): Promise<RuntimeResult<{ conversation_id: string }>>;
}

function readConversationIdFromRows(rows: ConversationMemoryRpcRow[] | null): string | null {
  if (!rows || rows.length === 0) return null;
  const raw = rows[0]?.conversation_id;
  return typeof raw === "string" ? raw : null;
}

export function createSupabaseOpenAIConversationMemoryRepository(deps: { rpc: RpcCaller }): OpenAIConversationMemoryRepository {
  return {
    async getConversationMemory(input) {
      const response = await deps.rpc<ConversationMemoryRpcRow[]>("core.rpc_get_openai_conversation_memory_v1", {
        p_clinic_id: input.clinic_id,
        p_channel: input.channel,
        p_external_user_id: input.external_user_id ?? null,
        p_chat_id: input.chat_id ?? null,
      });

      if (response.error) {
        return {
          ok: false,
          error: {
            code: "openai_conversation_memory_load_failed",
            message: "Failed to load OpenAI conversation memory via RPC",
            retryable: true,
          },
        };
      }

      return { ok: true, data: { conversation_id: readConversationIdFromRows(response.data) } };
    },

    async saveConversationMemory(input) {
      const response = await deps.rpc<ConversationMemoryRpcRow[]>("core.rpc_upsert_openai_conversation_memory_v1", {
        p_clinic_id: input.clinic_id,
        p_channel: input.channel,
        p_external_user_id: input.external_user_id ?? null,
        p_chat_id: input.chat_id ?? null,
        p_conversation_id: input.conversation_id,
      });

      if (response.error) {
        return {
          ok: false,
          error: {
            code: "openai_conversation_memory_save_failed",
            message: "Failed to save OpenAI conversation memory via RPC",
            retryable: true,
          },
        };
      }

      const conversationId = readConversationIdFromRows(response.data) ?? input.conversation_id;
      return { ok: true, data: { conversation_id: conversationId } };
    },
  };
}

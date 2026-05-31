import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseTurnPersistenceRepository } from "../src/runtime/supabaseTurnPersistenceRepository.ts";

test("mergeConversationState maps topic_memory patch into existing merge control flags", async () => {
  const calls: Array<{ name: string; params: Record<string, any> }> = [];
  const repo = createSupabaseTurnPersistenceRepository({
    async rpc(name, params) {
      calls.push({ name, params: params as Record<string, any> });
      return { data: null, error: null };
    },
  });

  const result = await repo.mergeConversationState({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    user_text: "на пломбу",
    reply_text: "same reply",
    requested_action: "continue",
    conversation_intent: "booking",
    handoff_recommended: false,
    confidence: "medium",
    control_flags: { openai_conversation_id: "conv_1", keep_me: true },
    topic_memory_patch: {
      topic_memory: {
        last_service_interest: "пломба",
        updated_at: "2026-05-31T12:00:00.000Z",
        source: "turn_understanding",
        confidence: "high",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].name, "rpc_merge_conversation_state");
  assert.deepEqual(calls[0].params.p_control_flags, {
    openai_conversation_id: "conv_1",
    keep_me: true,
    topic_memory: {
      last_service_interest: "пломба",
      updated_at: "2026-05-31T12:00:00.000Z",
      source: "turn_understanding",
      confidence: "high",
    },
  });
  assert.deepEqual(calls[0].params.p_slot_updates, {});
  assert.equal(calls[0].params.p_state_json, undefined);
  assert.equal(calls[0].params.p_patch, undefined);
});

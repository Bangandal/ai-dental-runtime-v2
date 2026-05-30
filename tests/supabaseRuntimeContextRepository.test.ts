import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseRuntimeContextRepository } from "../src/runtime/supabaseRuntimeContextRepository.ts";

test("maps real rpc_get_runtime_context out_* shape into compact runtime_context", async () => {
  const repo = createSupabaseRuntimeContextRepository({
    rpc: async () => ({
      data: [{
        out_state_json: {
          last_bot_action: "ask_service",
          last_bot_question: "Which service?",
          last_user_message_text: "Need cleaning",
          intent: "fallback_intent",
          conversation_stage: "qualification",
          qualification_stage: "service_selection",
          turn_count: 4,
          collected: { service: "cleaning" },
          missing_fields: ["date"],
          pending_slots: ["preferred_time", 7, ""],
        },
        out_state_version: 12,
        out_recent_messages: [{ role: "user", text: "hi" }],
        out_contact_meta: {
          first_name: "Ann",
          chat_id: "chat_1",
          external_user_id: "user_1",
          username: "ann123",
        },
        out_collected: { service: "exam" },
        out_missing_fields: ["time"],
        out_need_admin: true,
        out_last_intent: "book_visit",
      }],
      error: null,
    }),
  });

  const result = await repo.loadRuntimeContext({ clinic_id: "clinic_1", contact_id: "contact_1" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.conversation_state.state_version, 12);
  assert.deepEqual(result.data.conversation_state.collected, { service: "exam" });
  assert.deepEqual(result.data.conversation_state.missing_fields, ["time"]);
  assert.equal(result.data.conversation_state.intent, "book_visit");
  assert.deepEqual(result.data.conversation_state.pending_slots, ["preferred_time"]);
  assert.equal(result.data.known_contact.first_name, "Ann");
  assert.equal(result.data.known_contact.chat_id, "chat_1");
  assert.equal(result.data.known_contact.external_user_id, "user_1");
  assert.deepEqual(result.data.recent_history, []);
  assert.equal(result.data.runtime_flags.available_recent_history_count, 1);
});

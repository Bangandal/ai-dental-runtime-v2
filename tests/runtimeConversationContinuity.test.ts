import assert from "node:assert/strict";
import test from "node:test";

import { hasPriorDurablePatientTurn } from "../src/runtime/runtimeConversationContinuity.ts";
import type { RuntimeContext } from "../src/runtime/supabaseRuntimeContextRepository.ts";

function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    known_contact: {},
    conversation_state: { turn_count: 0, collected: {}, missing_fields: [] },
    topic_memory: null,
    channel_contact: null,
    provided_phone: null,
    booking_subjects: null,
    selected_slot_starts_at: null,
    case_context_lite: null,
    runtime_flags: {
      has_durable_context: true,
      context_source: "supabase",
      context_loaded_at: "2026-08-21T14:00:00.000Z",
      available_recent_history_count: 1,
    },
    recent_history: [{ role: "user", text: "current inbound" }],
    ...overrides,
  };
}

test("PF-009: current inbound alone is still a genuine first patient turn", () => {
  assert.equal(hasPriorDurablePatientTurn(context()), false);
});

test("PF-009: durable turn_count proves provider thread reset is not a new patient conversation", () => {
  assert.equal(hasPriorDurablePatientTurn(context({
    conversation_state: { turn_count: 3, collected: {}, missing_fields: [] },
  })), true);
});

test("PF-009: prior dialogue history proves continuity for legacy state without turn_count", () => {
  assert.equal(hasPriorDurablePatientTurn(context({
    runtime_flags: {
      has_durable_context: true,
      context_source: "supabase",
      context_loaded_at: "2026-08-21T14:00:00.000Z",
      available_recent_history_count: 3,
    },
    recent_history: [
      { role: "user", text: "old user" },
      { role: "assistant", text: "old reply" },
      { role: "user", text: "current inbound" },
    ],
  })), true);
});

test("PF-009: durable booking state proves continuity even when history metadata is sparse", () => {
  assert.equal(hasPriorDurablePatientTurn(context({
    selected_slot_starts_at: "2026-08-24T10:00:00+02:00",
  })), true);
});

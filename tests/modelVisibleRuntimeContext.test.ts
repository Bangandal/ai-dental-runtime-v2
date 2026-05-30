import assert from "node:assert/strict";
import test from "node:test";

import { buildModelVisibleRuntimeContext } from "../src/runtime/modelVisibleRuntimeContext.ts";

test("model-visible runtime context excludes phone from collected intake fields", () => {
  const result = buildModelVisibleRuntimeContext({
    known_contact: { first_name: "Ada", last_name: "Lovelace", phone_e164: "+15550001111" },
    conversation_state: {
      collected: {
        name: "Ada",
        service_interest: "cleaning",
        problem: "pain",
        phone: "+15550001111",
        phone_required: true,
        preferred_time: "tomorrow morning",
      },
      missing_fields: ["phone", "service_interest", 1],
      intent: "booking",
      last_bot_question: "When works?",
      last_bot_action: "ask_time",
      pending_slots: ["preferred_time"],
    },
  });

  const taskState = (result.task_state ?? {}) as Record<string, unknown>;
  const collected = (taskState.collected ?? {}) as Record<string, unknown>;
  const runtimePolicy = (result.runtime_policy ?? {}) as Record<string, unknown>;

  assert.equal("phone" in collected, false);
  assert.equal("phone_required" in collected, false);
  assert.deepEqual(taskState.missing_fields, ["service_interest"]);
  assert.equal(taskState.last_bot_question, undefined);
  assert.equal(taskState.last_bot_action, undefined);
  assert.equal(taskState.pending_slots, undefined);
  assert.equal(runtimePolicy.phone_required, false);
});

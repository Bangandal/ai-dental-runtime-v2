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
    },
  });

  const taskState = (result.task_state ?? {}) as Record<string, unknown>;
  const collected = (taskState.collected ?? {}) as Record<string, unknown>;
  const runtimePolicy = (result.runtime_policy ?? {}) as Record<string, unknown>;

  assert.equal("phone" in collected, false);
  assert.equal("phone_required" in collected, false);
  assert.deepEqual(taskState.missing_fields, ["service_interest"]);
  assert.equal(runtimePolicy.phone_required, false);
});

test("model-visible runtime context includes compact pending task continuation fields", () => {
  const result = buildModelVisibleRuntimeContext({
    conversation_state: {
      last_bot_question: "Какое время вам удобно?",
      last_bot_action: "collect_preferred_time",
      pending_slots: ["preferred_time", "service_interest", "", 1],
      conversation_intent: "booking_request",
      missing_fields: ["service_interest"],
      collected: {},
    },
  });

  const taskState = (result.task_state ?? {}) as Record<string, unknown>;
  assert.equal(taskState.last_bot_question, "Какое время вам удобно?");
  assert.equal(taskState.last_bot_action, "collect_preferred_time");
  assert.deepEqual(taskState.pending_slots, ["preferred_time", "service_interest"]);
  assert.equal(taskState.last_known_intent, "booking_request");
  assert.equal("recent_history" in taskState, false);
});

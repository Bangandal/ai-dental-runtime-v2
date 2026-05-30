import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackTurnUnderstandingDecision,
  createOpenAITurnUnderstandingClassifier,
  normalizeTurnUnderstandingDecision,
  runTurnUnderstandingShadow,
  sanitizeTurnUnderstandingContext,
  type TurnUnderstandingDecision,
} from "../src/runtime/turnUnderstandingShadow.ts";
import type { RuntimeGateDebug } from "../src/runtime/runtimeGateShadow.ts";

const operationalGate: RuntimeGateDebug = {
  enabled: true,
  mode: "shadow",
  route: "operational_candidate",
  turn_shape: "booking",
  confidence: "high",
  reason: "booking signal",
  should_apply: false,
};

const nonOperationalGate: RuntimeGateDebug = {
  enabled: true,
  mode: "shadow",
  route: "non_operational",
  turn_shape: "faq",
  confidence: "high",
  reason: "faq only",
  should_apply: false,
};

function decision(overrides: Partial<TurnUnderstandingDecision> = {}): TurnUnderstandingDecision {
  return {
    ...buildFallbackTurnUnderstandingDecision("mocked"),
    turn_type: "booking_request",
    reply_objective: "ask_missing_field",
    case_decision: { action: "open_new", case_kind: "booking", target_case_id: null },
    confidence: "high",
    reason: "mocked",
    ...overrides,
    should_apply: false,
  };
}

test("non_operational gate skips turn understanding", async () => {
  let calls = 0;
  const debug = await runTurnUnderstandingShadow({
    user_message: "Сколько стоит чистка?",
    runtime_gate: nonOperationalGate,
    runtime_context: {},
    classifier: { async classifyTurnUnderstanding() { calls += 1; return decision(); } },
  });

  assert.equal(calls, 0);
  assert.equal(debug.enabled, true);
  assert.equal(debug.mode, "shadow");
  assert.equal(debug.skipped, true);
  assert.equal(debug.skip_reason, "runtime_gate_non_operational");
  assert.equal(debug.decision, null);
});

test("operational gate runs turn understanding and returns mocked booking decision", async () => {
  const debug = await runTurnUnderstandingShadow({
    user_message: "могу записаться?",
    runtime_gate: operationalGate,
    runtime_context: {},
    classifier: { async classifyTurnUnderstanding() { return decision(); } },
  });

  assert.equal(debug.skipped, false);
  assert.equal(debug.skip_reason, null);
  assert.equal(debug.decision?.turn_type, "booking_request");
  assert.equal(debug.decision?.reply_objective, "ask_missing_field");
  assert.equal(debug.decision?.case_decision.action, "open_new");
  assert.equal(debug.decision?.case_decision.target_case_id, null);
  assert.equal(debug.decision?.should_apply, false);
});

test("slot fill mocked decision extracts service and date", async () => {
  const debug = await runTurnUnderstandingShadow({
    user_message: "чистка зубов на 05.06",
    runtime_gate: operationalGate,
    runtime_context: {},
    classifier: {
      async classifyTurnUnderstanding() {
        return decision({
          turn_type: "slot_fill",
          service_interest: "чистка зубов",
          slot_updates: { ...buildFallbackTurnUnderstandingDecision().slot_updates, service_interest: "чистка зубов", preferred_date: "05.06" },
        });
      },
    },
  });

  assert.equal(debug.decision?.turn_type, "slot_fill");
  assert.equal(debug.decision?.service_interest, "чистка зубов");
  assert.equal(debug.decision?.slot_updates.service_interest, "чистка зубов");
  assert.equal(debug.decision?.slot_updates.preferred_date, "05.06");
});

test("name and time mocked decision extracts first_name, last_name, and preferred_time", async () => {
  const debug = await runTurnUnderstandingShadow({
    user_message: "14.00 михаил огар",
    runtime_gate: operationalGate,
    runtime_context: {},
    classifier: {
      async classifyTurnUnderstanding() {
        return decision({
          turn_type: "slot_fill",
          slot_updates: { ...buildFallbackTurnUnderstandingDecision().slot_updates, preferred_time: "14.00", first_name: "михаил", last_name: "огар" },
        });
      },
    },
  });

  assert.equal(debug.decision?.slot_updates.preferred_time, "14.00");
  assert.equal(debug.decision?.slot_updates.first_name, "михаил");
  assert.equal(debug.decision?.slot_updates.last_name, "огар");
});


test("booking request missing_fields filters phone for messenger MVP", async () => {
  const debug = await runTurnUnderstandingShadow({
    user_message: "могу записаться?",
    runtime_gate: operationalGate,
    runtime_context: {},
    classifier: {
      async classifyTurnUnderstanding() {
        return decision({ missing_fields: ["phone", "service_interest", "preferred_date"] });
      },
    },
  });

  assert.deepEqual(debug.decision?.missing_fields, ["service_interest", "preferred_date"]);
  assert.equal(debug.decision?.should_apply, false);
});

test("slot fill missing_fields filters phone for messenger MVP", async () => {
  const debug = await runTurnUnderstandingShadow({
    user_message: "чистка зубов на 05.06",
    runtime_gate: operationalGate,
    runtime_context: {},
    classifier: {
      async classifyTurnUnderstanding() {
        return decision({ turn_type: "slot_fill", missing_fields: ["phone", "preferred_time", "first_name", "last_name"] });
      },
    },
  });

  assert.deepEqual(debug.decision?.missing_fields, ["preferred_time", "first_name", "last_name"]);
});

test("reschedule missing_fields filters phone for messenger MVP", async () => {
  const debug = await runTurnUnderstandingShadow({
    user_message: "перенести запись",
    runtime_gate: operationalGate,
    runtime_context: {},
    classifier: {
      async classifyTurnUnderstanding() {
        return decision({
          turn_type: "reschedule",
          case_decision: { action: "update_existing", case_kind: "reschedule", target_case_id: null },
          missing_fields: ["phone", "preferred_date", "preferred_time"],
        });
      },
    },
  });

  assert.deepEqual(debug.decision?.missing_fields, ["preferred_date", "preferred_time"]);
});

test("normalization filters classifier phone and non-MVP booking missing fields", () => {
  const normalized = normalizeTurnUnderstandingDecision(decision({
    turn_type: "booking_request",
    missing_fields: ["phone", "service_interest", "insurance", "first_name", "phone"],
  }));

  assert.deepEqual(normalized.missing_fields, ["service_interest", "first_name"]);
  assert.equal(normalized.should_apply, false);
});

test("invalid classifier output falls back safely", async () => {
  const debug = await runTurnUnderstandingShadow({
    user_message: "запишите",
    runtime_gate: operationalGate,
    runtime_context: {},
    classifier: { async classifyTurnUnderstanding() { return { turn_type: "booking_request", should_apply: true }; } },
  });

  assert.equal(debug.skipped, false);
  assert.equal(debug.decision?.turn_type, "unknown");
  assert.equal(debug.decision?.reply_objective, "safe_fallback");
  assert.equal(debug.decision?.case_decision.action, "none");
  assert.equal(debug.decision?.confidence, "low");
  assert.equal(debug.decision?.should_apply, false);
  assert.equal(debug.error, "classifier_invalid_output");
});

test("sanitizer keeps pending continuation fields only in turn understanding context and removes ids/history", () => {
  const sanitized = sanitizeTurnUnderstandingContext({
    user_message: "14.00 михаил огар",
    runtime_gate: operationalGate,
    runtime_context: {
      clinic_id: "clinic_1",
      contact_id: "contact_1",
      recent_history: [{ role: "user", text: "raw" }],
      task_state: { last_bot_question: "На какое время?", pending_slots: ["preferred_time", "first_name", 7], collected: { case_id: "case_1", service_interest: "cleaning" } },
      topic_memory: { last_topic: "booking", contact_id: "contact_1" },
      booking_context: { latest_appointment: { appointment_id: "apt_1", service_interest: "exam" } },
      case_context: { current_case: { case_id: "case_2", case_type: "booking" }, recent_cases: [{ case_id: "case_3", topic: "x" }] },
    },
  });

  const ctx = sanitized.runtime_context as Record<string, any>;
  assert.equal(ctx.user_message, "14.00 михаил огар");
  assert.deepEqual(ctx.pending_slots, ["preferred_time", "first_name"]);
  assert.equal(ctx.last_bot_question, "На какое время?");
  assert.equal(ctx.recent_history, undefined);
  assert.equal(ctx.clinic_id, undefined);
  assert.equal(ctx.task_state.collected.case_id, undefined);
  assert.equal(ctx.topic_memory.contact_id, undefined);
  assert.equal(ctx.latest_appointment.appointment_id, undefined);
  assert.equal(ctx.case_context.current_case.case_id, undefined);
  assert.equal(ctx.case_context.recent_cases[0].case_id, undefined);
});

test("OpenAI classifier uses turn understanding model and parses output_text", async () => {
  const seen: unknown[] = [];
  const classifier = createOpenAITurnUnderstandingClassifier({
    model: "tu-model",
    client: {
      responses: {
        async create(input) {
          seen.push(input);
          return { output_text: JSON.stringify(decision({ turn_type: "admin_request", reply_objective: "handoff", case_decision: { action: "handoff", case_kind: "admin", target_case_id: null } })) };
        },
      },
    },
  });

  const result = await classifier.classifyTurnUnderstanding({ user_message: "администратора", runtime_gate: operationalGate, runtime_context: {} });
  assert.equal((seen[0] as any).model, "tu-model");
  assert.match((seen[0] as any).instructions, /phone is not a required field for messenger channels/i);
  assert.match((seen[0] as any).instructions, /Never include phone in missing_fields/i);
  assert.equal((result as any).turn_type, "admin_request");
});

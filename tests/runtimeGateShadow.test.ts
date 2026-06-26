import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFallbackRuntimeGateDebug,
  createOpenAIRuntimeGateClassifier,
  normalizeRuntimeGateDebug,
  runRuntimeGateShadow,
  sanitizeRuntimeGateContext,
} from "../src/runtime/runtimeGateShadow.ts";

const examples = [
  {
    name: "greeting is non-operational",
    user_message: "Привет",
    classifier_output: { route: "non_operational", turn_shape: "greeting", confidence: "high", reason: "Greeting only.", should_apply: false },
    route: "non_operational",
    turn_shape: "greeting",
  },
  {
    name: "price question is FAQ and non-operational",
    user_message: "Сколько стоит чистка?",
    classifier_output: { route: "non_operational", turn_shape: "faq", confidence: "high", reason: "Asks for pricing only.", should_apply: false },
    route: "non_operational",
    turn_shape: "faq",
  },
  {
    name: "booking request is operational candidate",
    user_message: "Хочу записаться на прием",
    classifier_output: { route: "operational_candidate", turn_shape: "booking", confidence: "high", reason: "Asks to book an appointment.", should_apply: false },
    route: "operational_candidate",
    turn_shape: "booking",
  },
  {
    name: "mixed booking and price is operational candidate",
    user_message: "Хочу записаться и узнать цены",
    classifier_output: { route: "operational_candidate", turn_shape: "mixed", confidence: "high", reason: "Combines booking with pricing.", should_apply: false },
    route: "operational_candidate",
    turn_shape: "mixed",
  },
  {
    name: "vague short message without pending context is unclear and non-operational",
    user_message: "да",
    classifier_output: { route: "non_operational", turn_shape: "unclear", confidence: "low", reason: "Short ambiguous reply without pending context.", should_apply: false },
    route: "non_operational",
    turn_shape: "unclear",
  },
] as const;

for (const example of examples) {
  test(`runtime gate classifier shape: ${example.name}`, async () => {
    const debug = await runRuntimeGateShadow({
      user_message: example.user_message,
      runtime_context: {},
      classifier: { classifyRuntimeGateTurn: async () => example.classifier_output },
    });

    assert.equal(debug.enabled, true);
    assert.equal(debug.mode, "shadow");
    assert.equal(debug.route, example.route);
    assert.equal(debug.turn_shape, example.turn_shape);
    assert.equal(debug.should_apply, false);
  });
}

test("fallback is safe and non-fatal when classifier throws", async () => {
  const debug = await runRuntimeGateShadow({
    user_message: "Хочу записаться",
    runtime_context: {},
    classifier: { classifyRuntimeGateTurn: async () => { throw new Error("classifier failed"); } },
  });

  assert.deepEqual(debug, buildFallbackRuntimeGateDebug());
});

test("invalid classifier output normalizes conservatively and never applies", () => {
  const debug = normalizeRuntimeGateDebug({
    enabled: false,
    mode: "live",
    route: "book_now",
    turn_shape: "unknown_shape",
    confidence: "certain",
    reason: "   ",
    should_apply: true,
  });

  assert.equal(debug.enabled, true);
  assert.equal(debug.mode, "shadow");
  assert.equal(debug.route, "non_operational");
  assert.equal(debug.turn_shape, "unclear");
  assert.equal(debug.confidence, "low");
  assert.equal(debug.should_apply, false);
});

test("sanitizes runtime context to pending-task signals without mutating input", () => {
  const raw = {
    task_state: {
      missing_fields: ["service_interest", 7],
      last_known_intent: "booking",
      intake_status: "collecting",
      collected: { name: "Ana" },
      last_bot_question: "Какой день вам удобен?",
      last_bot_action: "ask_preferred_day",
      pending_slots: ["preferred_day", "preferred_time", 5, ""],
    },
    booking_context: { has_active_hold: true, active_hold: { label: "10:00" } },
    case_context: { has_current_case: true, open_cases_count: 1, current_case: { case_type: "booking" } },
  };

  const sanitized = sanitizeRuntimeGateContext(raw);
  const taskState = sanitized.task_state as Record<string, unknown>;

  assert.deepEqual(taskState.missing_fields, ["service_interest"]);
  assert.equal(taskState.last_bot_question, "Какой день вам удобен?");
  assert.equal(taskState.last_bot_action, "ask_preferred_day");
  assert.deepEqual(taskState.pending_slots, ["preferred_day", "preferred_time"]);
  assert.equal((sanitized.booking_context as any).has_active_hold, true);
  assert.equal((sanitized.case_context as any).has_current_case, true);
  assert.deepEqual((raw.task_state as any).missing_fields, ["service_interest", 7]);
});

test("sanitizes continuation signals from raw conversation_state for runtime gate only", () => {
  const sanitized = sanitizeRuntimeGateContext({
    conversation_state: {
      missing_fields: ["preferred_time", 10],
      intent: "booking",
      qualification_stage: "collecting",
      collected: { service_interest: "cleaning" },
      last_bot_question: "Когда вам удобно?",
      last_bot_action: "ask_time",
      pending_slots: ["preferred_time", "service_interest", null],
    },
  });

  const taskState = sanitized.task_state as Record<string, unknown>;
  assert.deepEqual(taskState.missing_fields, ["preferred_time"]);
  assert.equal(taskState.last_known_intent, "booking");
  assert.equal(taskState.intake_status, "collecting");
  assert.equal(taskState.last_bot_question, "Когда вам удобно?");
  assert.equal(taskState.last_bot_action, "ask_time");
  assert.deepEqual(taskState.pending_slots, ["preferred_time", "service_interest"]);
});


test("vague short message with pending context can be shadow-classified as a slot fragment", async () => {
  let classifierInput: Record<string, unknown> | null = null;
  const runtimeContext = sanitizeRuntimeGateContext({
    task_state: {
      last_bot_question: "Когда вам удобно?",
      last_bot_action: "ask_time",
      pending_slots: ["preferred_time"],
    },
  });

  const debug = await runRuntimeGateShadow({
    user_message: "завтра",
    runtime_context: runtimeContext,
    classifier: {
      async classifyRuntimeGateTurn(input) {
        classifierInput = input.runtime_context;
        return {
          route: "operational_candidate",
          turn_shape: "slot_fragment",
          confidence: "medium",
          reason: "Short reply answers the pending time question.",
          should_apply: false,
        };
      },
    },
  });

  assert.equal(((classifierInput?.task_state as Record<string, unknown>) ?? {}).last_bot_question, "Когда вам удобно?");
  assert.deepEqual(((classifierInput?.task_state as Record<string, unknown>) ?? {}).pending_slots, ["preferred_time"]);
  assert.equal(debug.route, "operational_candidate");
  assert.equal(debug.turn_shape, "slot_fragment");
  assert.equal(debug.should_apply, false);
});

test("OpenAI runtime gate classifier uses the supplied mini model and parses output", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const classifier = createOpenAIRuntimeGateClassifier({
    model: "gpt-runtime-gate-mini",
    client: {
      responses: {
        async create(payload: Record<string, unknown>) {
          calls.push(payload);
          return { output_text: "{\"route\":\"non_operational\",\"turn_shape\":\"greeting\",\"confidence\":\"high\",\"reason\":\"Greeting only.\",\"should_apply\":false}" };
        },
      },
    } as any,
  });

  const debug = await runRuntimeGateShadow({ user_message: "hi", runtime_context: {}, classifier });

  assert.equal(calls[0]?.model, "gpt-runtime-gate-mini");
  assert.equal(debug.route, "non_operational");
  assert.equal(debug.turn_shape, "greeting");
});

test("runtime gate source has no apply RPC or regex semantic routing", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/runtimeGateShadow.ts"), "utf8");

  assert.equal(source.includes("rpc_apply"), false);
  assert.equal(source.includes("new RegExp"), false);
  assert.equal(source.includes("BOOKING_INTENT_PATTERNS"), false);
});

// CBM v1 safety hotfix — classification routing tests

test("CBM/E3: post-extraction bleeding routes operational_candidate/urgent, not non_operational", async () => {
  const debug = await runRuntimeGateShadow({
    user_message: "Кровит после удаления зуба",
    runtime_context: {},
    classifier: {
      classifyRuntimeGateTurn: async () => ({
        route: "operational_candidate",
        turn_shape: "urgent",
        confidence: "high",
        reason: "Post-procedure bleeding reported; clinical urgency bypass applied.",
        should_apply: false,
      }),
    },
  });

  assert.equal(debug.route, "operational_candidate");
  assert.equal(debug.turn_shape, "urgent");
  assert.equal(debug.should_apply, false);
});

test("CBM/E1: severe tooth pain routes operational_candidate/urgent", async () => {
  const debug = await runRuntimeGateShadow({
    user_message: "У меня сильная зубная боль, нужно срочно",
    runtime_context: {},
    classifier: {
      classifyRuntimeGateTurn: async () => ({
        route: "operational_candidate",
        turn_shape: "urgent",
        confidence: "high",
        reason: "Severe dental pain reported; clinical urgency bypass applied.",
        should_apply: false,
      }),
    },
  });

  assert.equal(debug.route, "operational_candidate");
  assert.equal(debug.turn_shape, "urgent");
  assert.equal(debug.should_apply, false);
});

test("CBM/F2: human person request routes operational_candidate/admin_request", async () => {
  const debug = await runRuntimeGateShadow({
    user_message: "Хочу поговорить с человеком",
    runtime_context: {},
    classifier: {
      classifyRuntimeGateTurn: async () => ({
        route: "operational_candidate",
        turn_shape: "admin_request",
        confidence: "high",
        reason: "User requests to speak with a human; admin_request route applied.",
        should_apply: false,
      }),
    },
  });

  assert.equal(debug.route, "operational_candidate");
  assert.equal(debug.turn_shape, "admin_request");
  assert.equal(debug.should_apply, false);
});

test("CBM/H1: imperative cancel ('Отмените мою запись') routes operational_candidate/cancel", async () => {
  const debug = await runRuntimeGateShadow({
    user_message: "Отмените мою запись",
    runtime_context: {},
    classifier: {
      classifyRuntimeGateTurn: async () => ({
        route: "operational_candidate",
        turn_shape: "cancel",
        confidence: "high",
        reason: "Cancel request; operational regardless of appointment existence.",
        should_apply: false,
      }),
    },
  });

  assert.equal(debug.route, "operational_candidate");
  assert.equal(debug.turn_shape, "cancel");
  assert.equal(debug.should_apply, false);
});

test("CBM/H2: nominal cancel ('Хочу отменить запись') routes operational_candidate/cancel — consistent with H1", async () => {
  const debug = await runRuntimeGateShadow({
    user_message: "Хочу отменить запись",
    runtime_context: {},
    classifier: {
      classifyRuntimeGateTurn: async () => ({
        route: "operational_candidate",
        turn_shape: "cancel",
        confidence: "high",
        reason: "Cancel request.",
        should_apply: false,
      }),
    },
  });

  assert.equal(debug.route, "operational_candidate");
  assert.equal(debug.turn_shape, "cancel");
  assert.equal(debug.should_apply, false);
});

test("CBM gate safety rules are present in gate instructions source", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/runtimeGateShadow.ts"), "utf8");

  assert.ok(source.includes("CLINICAL URGENCY BYPASS"), "gate instructions must have clinical urgency bypass rule");
  assert.ok(source.includes("HUMAN OR PERSON REQUEST"), "gate instructions must have human/person request rule");
  assert.ok(source.includes("CANCEL REQUEST CONSISTENCY"), "gate instructions must have cancel consistency rule");
  assert.ok(source.includes("operational_candidate"), "gate must define operational_candidate route");
});

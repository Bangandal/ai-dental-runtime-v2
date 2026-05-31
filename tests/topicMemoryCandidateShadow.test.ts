import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTopicMemoryCandidateShadow, buildTopicMemoryPatch } from "../src/runtime/topicMemoryCandidateShadow.ts";
import { buildFallbackTurnUnderstandingDecision, type TurnUnderstandingDebug, type TurnUnderstandingDecision } from "../src/runtime/turnUnderstandingShadow.ts";

function debugForDecision(overrides: Partial<TurnUnderstandingDecision> = {}): TurnUnderstandingDebug {
  return {
    enabled: true,
    mode: "shadow",
    skipped: false,
    skip_reason: null,
    decision: {
      ...buildFallbackTurnUnderstandingDecision("mocked"),
      turn_type: "booking_request",
      service_interest: null,
      subject: { kind: "self", display_name: null },
      reply_objective: "ask_missing_field",
      case_decision: { action: "open_new", case_kind: "booking", target_case_id: null },
      slot_updates: { service_interest: null, preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      missing_fields: [],
      confidence: "high",
      reason: "mocked",
      ...overrides,
      should_apply: false,
    },
    error: null,
  };
}

function skippedDebug(): TurnUnderstandingDebug {
  return {
    enabled: true,
    mode: "shadow",
    skipped: true,
    skip_reason: "runtime_gate_non_operational",
    decision: null,
    error: null,
  };
}

test("service_interest пломба emits update candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    turn_understanding: debugForDecision({ service_interest: "пломба", confidence: "high" }),
  });

  assert.equal(debug.enabled, true);
  assert.equal(debug.mode, "shadow");
  assert.equal(debug.should_update, true);
  assert.equal(debug.topic_kind, "service_interest");
  assert.equal(debug.topic_value, "пломба");
  assert.equal(debug.confidence, "high");
  assert.equal(debug.reason, null);
});

test("slot_updates.service_interest отбеливание зубов emits update candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    turn_understanding: debugForDecision({
      service_interest: null,
      slot_updates: { service_interest: "отбеливание зубов", preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      confidence: "medium",
    }),
  });

  assert.equal(debug.should_update, true);
  assert.equal(debug.topic_kind, "service_interest");
  assert.equal(debug.topic_value, "отбеливание зубов");
  assert.equal(debug.confidence, "medium");
});

test("service_interest брекеты emits update candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    turn_understanding: debugForDecision({ service_interest: "брекеты", confidence: "high" }),
  });

  assert.equal(debug.should_update, true);
  assert.equal(debug.topic_kind, "service_interest");
  assert.equal(debug.topic_value, "брекеты");
});

test("greeting emits no topic candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    turn_understanding: debugForDecision({
      turn_type: "unknown",
      service_interest: null,
      slot_updates: { service_interest: null, preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      confidence: "low",
    }),
  });

  assert.equal(debug.should_update, false);
  assert.equal(debug.topic_kind, null);
  assert.equal(debug.topic_value, null);
  assert.equal(debug.confidence, null);
  assert.equal(debug.reason, null);
});

test("faq price only emits no topic candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    turn_understanding: debugForDecision({
      turn_type: "unknown",
      topic: "price",
      service_interest: null,
      slot_updates: { service_interest: null, preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      reply_objective: "answer",
      confidence: "high",
    }),
  });

  assert.equal(debug.should_update, false);
  assert.equal(debug.topic_kind, null);
  assert.equal(debug.topic_value, null);
});


test("non operational FAQ with service word but no typed source emits no typed source reason", () => {
  const debug = buildTopicMemoryCandidateShadow({
    user_message: "какая цена на пломбу?",
    runtime_gate: { enabled: true, mode: "shadow", route: "non_operational", turn_shape: "faq", confidence: "high", reason: "faq", should_apply: false },
    turn_understanding: skippedDebug(),
  });

  assert.equal(debug.should_update, false);
  assert.equal(debug.topic_kind, null);
  assert.equal(debug.topic_value, null);
  assert.equal(debug.confidence, null);
  assert.equal(debug.reason, "no_typed_topic_source");
});

test("non operational unclear with service word but no typed source emits no typed source reason", () => {
  const debug = buildTopicMemoryCandidateShadow({
    user_message: "брекеты",
    runtime_gate: { enabled: true, mode: "shadow", route: "non_operational", turn_shape: "unclear", confidence: "medium", reason: "unclear", should_apply: false },
    turn_understanding: skippedDebug(),
  });

  assert.equal(debug.should_update, false);
  assert.equal(debug.topic_kind, null);
  assert.equal(debug.topic_value, null);
  assert.equal(debug.confidence, null);
  assert.equal(debug.reason, "no_typed_topic_source");
});

test("non operational FAQ generic price emits no topic candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    user_message: "какая цена?",
    runtime_gate: { enabled: true, mode: "shadow", route: "non_operational", turn_shape: "faq", confidence: "high", reason: "faq", should_apply: false },
    turn_understanding: skippedDebug(),
  });

  assert.equal(debug.should_update, false);
  assert.equal(debug.topic_kind, null);
  assert.equal(debug.topic_value, null);
  assert.equal(debug.confidence, null);
});

test("non operational greeting emits no topic candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    user_message: "здравствуйте",
    runtime_gate: { enabled: true, mode: "shadow", route: "non_operational", turn_shape: "greeting", confidence: "high", reason: "greeting", should_apply: false },
    turn_understanding: skippedDebug(),
  });

  assert.equal(debug.should_update, false);
  assert.equal(debug.topic_kind, null);
  assert.equal(debug.topic_value, null);
});

test("non operational thanks emits no topic candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({
    user_message: "спасибо",
    runtime_gate: { enabled: true, mode: "shadow", route: "non_operational", turn_shape: "other", confidence: "high", reason: "thanks", should_apply: false },
    turn_understanding: skippedDebug(),
  });

  assert.equal(debug.should_update, false);
  assert.equal(debug.topic_kind, null);
  assert.equal(debug.topic_value, null);
});

test("turn understanding service_interest wins for non operational FAQ input", () => {
  const debug = buildTopicMemoryCandidateShadow({
    user_message: "сколько стоит пломба?",
    runtime_gate: { enabled: true, mode: "shadow", route: "non_operational", turn_shape: "faq", confidence: "high", reason: "faq", should_apply: false },
    turn_understanding: debugForDecision({ service_interest: "чистка зубов", confidence: "high" }),
  });

  assert.equal(debug.should_update, true);
  assert.equal(debug.topic_kind, "service_interest");
  assert.equal(debug.topic_value, "чистка зубов");
  assert.equal(debug.confidence, "high");
  assert.equal(debug.reason, null);
});

test("turn_understanding skipped emits skipped reason and no candidate", () => {
  const debug = buildTopicMemoryCandidateShadow({ turn_understanding: skippedDebug() });

  assert.deepEqual(debug, {
    enabled: true,
    mode: "shadow",
    should_update: false,
    topic_kind: null,
    topic_value: null,
    confidence: null,
    reason: "turn_understanding_skipped",
  });
});


test("buildTopicMemoryPatch creates service_interest state patch from typed candidate", () => {
  const candidate = buildTopicMemoryCandidateShadow({
    turn_understanding: debugForDecision({ service_interest: " пломба ", confidence: "high" }),
  });

  const patch = buildTopicMemoryPatch(candidate, new Date("2026-05-31T12:00:00.000Z"));

  assert.deepEqual(patch, {
    topic_memory: {
      last_service_interest: "пломба",
      updated_at: "2026-05-31T12:00:00.000Z",
      source: "turn_understanding",
      confidence: "high",
    },
  });
});

test("buildTopicMemoryPatch skips no_typed_topic_source candidate", () => {
  const candidate = buildTopicMemoryCandidateShadow({
    user_message: "какая цена на пломбу?",
    runtime_gate: { enabled: true, mode: "shadow", route: "non_operational", turn_shape: "faq", confidence: "high", reason: "faq", should_apply: false },
    turn_understanding: skippedDebug(),
  });

  assert.equal(buildTopicMemoryPatch(candidate, new Date("2026-05-31T12:00:00.000Z")), null);
});

test("buildTopicMemoryPatch skips non-update candidate", () => {
  const candidate = buildTopicMemoryCandidateShadow({
    turn_understanding: debugForDecision({
      turn_type: "unknown",
      service_interest: null,
      slot_updates: { service_interest: null, preferred_date: null, preferred_time: null, first_name: null, last_name: null, offered_slot_id: null, confirmation_target: null },
      confidence: "low",
    }),
  });

  assert.equal(buildTopicMemoryPatch(candidate, new Date("2026-05-31T12:00:00.000Z")), null);
});

test("topic memory candidate builder does not mutate turn_understanding", () => {
  const turnUnderstanding = debugForDecision({ service_interest: "пломба" });
  const before = structuredClone(turnUnderstanding);

  buildTopicMemoryCandidateShadow({ turn_understanding: turnUnderstanding });

  assert.deepEqual(turnUnderstanding, before);
});

test("topic memory candidate shadow has no database, model, or persistence calls", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(thisDir, "../src/runtime/topicMemoryCandidateShadow.ts"), "utf8");

  assert.doesNotMatch(source, /from\s+["']([^"']*openai[^"']*)["']/i);
  assert.doesNotMatch(source, /responses\.create|classify[A-Z]/);
  assert.doesNotMatch(source, /from\s+["']([^"']*supabase[^"']*)["']/i);
  assert.doesNotMatch(source, /repository|rpc|save[A-Z]|insert[A-Z]|update[A-Z]|delete[A-Z]/);
});

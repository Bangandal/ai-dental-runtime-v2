import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFallbackCaseRouterDecision,
  normalizeCaseRouterDecision,
  runCaseRouterShadow,
  sanitizeCaseRouterContext,
} from "../src/runtime/caseRouterShadow.ts";

test("fallback decision is conservative and should_apply false", () => {
  const decision = buildFallbackCaseRouterDecision();
  assert.equal(decision.case_relation, "unknown");
  assert.equal(decision.case_action, "no_case");
  assert.equal(decision.case_type, "other");
  assert.equal(decision.priority, "normal");
  assert.equal(decision.confidence, "low");
  assert.equal(decision.should_apply, false);
});

test("invalid classifier output is normalized", () => {
  const decision = normalizeCaseRouterDecision({
    case_relation: "weird",
    case_action: "maybe",
    case_type: "booking",
    topic: "   ",
    status: "not_real",
    priority: "p1",
    confidence: "certain",
    reason: "",
    should_apply: true,
  });
  assert.equal(decision.case_relation, "unknown");
  assert.equal(decision.case_action, "no_case");
  assert.equal(decision.case_type, "other");
  assert.equal(decision.topic, null);
  assert.equal(decision.status, null);
  assert.equal(decision.priority, "normal");
  assert.equal(decision.confidence, "low");
  assert.equal(decision.should_apply, false);
});

test("shadow debug envelope is enabled and never applied", () => {
  const debug = runCaseRouterShadow({ user_message: "hi", runtime_context: {} });
  return debug.then((resolved) => {
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.mode, "shadow");
    assert.equal(resolved.classifier, "fallback");
    assert.equal(resolved.applied, false);
    assert.equal(resolved.decision.should_apply, false);
    assert.equal(resolved.error, null);
  });
});

test("source has no rpc_apply_case_decision_v1 or regex intent detection", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/caseRouterShadow.ts");
  const source = await readFile(modulePath, "utf8");

  assert.equal(source.includes("rpc_apply_case_decision_v1"), false);
  assert.equal(source.includes("BOOKING_INTENT_PATTERNS"), false);
  assert.equal(source.includes("new RegExp"), false);
});

test("sanitizeCaseRouterContext keeps only model-visible compact fields", () => {
  const sanitized = sanitizeCaseRouterContext({
    patient_context: { locale: "ru" },
    task_state: { phase: "collecting", last_bot_question: "Когда вам удобно?", pending_slots: ["preferred_time"] },
    case_context: { has_current_case: true },
    booking_context: { has_active_hold: false },
    clinic_id: "hidden",
    case_id: "hidden",
    contact_id: "hidden",
    chat_id: "hidden",
    external_user_id: "hidden",
    trace_id: "hidden",
  });
  assert.equal("clinic_id" in sanitized, false);
  assert.equal("case_id" in sanitized, false);
  assert.equal("contact_id" in sanitized, false);
  assert.equal("chat_id" in sanitized, false);
  assert.equal("external_user_id" in sanitized, false);
  assert.equal("trace_id" in sanitized, false);
  assert.deepEqual((sanitized.task_state as Record<string, unknown>).pending_slots, ["preferred_time"]);
});

test("invalid enum classifier output falls back with classifier_invalid_output", async () => {
  const debug = await runCaseRouterShadow({
    user_message: "hello",
    runtime_context: {},
    classifier: {
      async classifyCaseTurn() {
        return {
          decision: {
            case_relation: "bad",
            case_action: "reuse_case",
            case_type: "faq",
            status: null,
            priority: "normal",
            confidence: "high",
            reason: "x",
            should_apply: true,
          },
          classifier_raw_output: "{\"case_relation\":\"bad\"}",
          classifier_raw_parsed: {
            case_relation: "bad",
            case_action: "reuse_case",
            case_type: "faq",
            status: null,
            priority: "normal",
            confidence: "high",
            reason: "x",
            should_apply: true,
          },
        };
      },
    },
  });
  assert.equal(debug.classifier, "fallback");
  assert.equal(debug.error?.code, "classifier_invalid_output");
  assert.equal(debug.decision.should_apply, false);
  assert.equal(debug.classifier_raw_output, "{\"case_relation\":\"bad\"}");
  assert.deepEqual(debug.classifier_raw_parsed, {
    case_relation: "bad",
    case_action: "reuse_case",
    case_type: "faq",
    status: null,
    priority: "normal",
    confidence: "high",
    reason: "x",
    should_apply: true,
  });
});

test("classifier openai label used only for semantically valid decision", async () => {
  const debug = await runCaseRouterShadow({
    user_message: "hello",
    runtime_context: {},
    classifier: {
      async classifyCaseTurn() {
        return {
          case_relation: "same_case",
          case_action: "reuse_case",
          case_type: "follow_up",
          topic: "results",
          status: "open",
          priority: "normal",
          confidence: "high",
          reason: "Continues current case",
          should_apply: true,
        };
      },
    },
  });
  assert.equal(debug.classifier, "openai");
  assert.equal(debug.decision.should_apply, false);
});

test("invalid classifier json is distinguished from classifier exceptions", async () => {
  const debug = await runCaseRouterShadow({
    user_message: "hello",
    runtime_context: {},
    classifier: {
      async classifyCaseTurn() {
        const error = new Error("invalid_classifier_json") as Error & { classifier_raw_output?: string };
        error.classifier_raw_output = "{bad";
        throw error;
      },
    },
  });
  assert.equal(debug.classifier, "fallback");
  assert.equal(debug.error?.code, "invalid_classifier_json");
  assert.equal(debug.classifier_raw_output, "{bad");
});

test("raw classifier output and parsed object are logged in debug envelope", async () => {
  const debug = await runCaseRouterShadow({
    user_message: "hello",
    runtime_context: {},
    classifier: {
      async classifyCaseTurn() {
        return {
          decision: {
            case_relation: "same_case",
            case_action: "reuse_case",
            case_type: "follow_up",
            topic: "results",
            status: "open",
            priority: "normal",
            confidence: "high",
            reason: "Continues current case",
            should_apply: true,
          },
          classifier_raw_output: "```json\n{\"case_relation\":\"same_case\"}\n```",
          classifier_raw_parsed: { case_relation: "same_case" },
        };
      },
    },
  });
  assert.equal(debug.classifier_raw_output, "```json\n{\"case_relation\":\"same_case\"}\n```");
  assert.deepEqual(debug.classifier_raw_parsed, { case_relation: "same_case" });
});

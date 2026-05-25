import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFallbackCaseRouterDecision,
  normalizeCaseRouterDecision,
  runCaseRouterShadow,
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
  const debug = runCaseRouterShadow();
  assert.equal(debug.enabled, true);
  assert.equal(debug.mode, "shadow");
  assert.equal(debug.applied, false);
  assert.equal(debug.decision.should_apply, false);
  assert.equal(debug.error, null);
});

test("source has no rpc_apply_case_decision_v1 or regex intent detection", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(thisDir, "../src/runtime/caseRouterShadow.ts");
  const source = await readFile(modulePath, "utf8");

  assert.equal(source.includes("rpc_apply_case_decision_v1"), false);
  assert.equal(source.includes("BOOKING_INTENT_PATTERNS"), false);
  assert.equal(source.includes("new RegExp"), false);
});

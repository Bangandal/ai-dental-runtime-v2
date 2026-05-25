import assert from "node:assert/strict";
import test from "node:test";

import { parseClassifierJson } from "../src/runtime/openaiCaseRouterClassifier.ts";

test("parseClassifierJson parses fenced json block", () => {
  const parsed = parseClassifierJson("```json\n{\"case_relation\":\"unknown\"}\n```") as Record<string, unknown>;
  assert.equal(parsed.case_relation, "unknown");
});

test("parseClassifierJson throws invalid_classifier_json for malformed json", () => {
  assert.throws(() => parseClassifierJson("{not-json"), (error: unknown) => {
    return error instanceof Error && error.message === "invalid_classifier_json";
  });
});

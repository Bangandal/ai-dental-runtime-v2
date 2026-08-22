import assert from "node:assert/strict";
import test from "node:test";

import { readRuntimeServerEnv } from "../src/index.ts";

test("runtime server defaults the patient-facing agent to gpt-5.4-mini", () => {
  const env = readRuntimeServerEnv({});
  assert.equal(env.runtimeModel, "gpt-5.4-mini");
  assert.equal(env.runtimeEmbeddingModel, "text-embedding-3-small");
});

test("runtime server still honors an explicit model override", () => {
  const env = readRuntimeServerEnv({
    RUNTIME_OPENAI_MODEL: "gpt-test-override",
    RUNTIME_EMBEDDING_MODEL: "embedding-test-override",
  });
  assert.equal(env.runtimeModel, "gpt-test-override");
  assert.equal(env.runtimeEmbeddingModel, "embedding-test-override");
});

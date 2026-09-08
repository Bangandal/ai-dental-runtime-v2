import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeOrchestrationDeps } from "../src/runtime/runtimeServerBootstrap.ts";
import { buildModelVisibleRuntimeContext } from "../src/runtime/modelVisibleRuntimeContext.ts";
import type { OpenAIResponsesClient } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import type { RpcCaller } from "../src/runtime/runtimeRepositories.ts";
import type { EmbeddingClient } from "../src/runtime/supabaseKnowledgeRepository.ts";

const openaiClient: OpenAIResponsesClient = {
  responses: {
    create: async () => ({}),
  },
};

const rpc: RpcCaller = async <TResult>() => ({
  data: null as TResult | null,
  error: null,
});

const embeddingClient: EmbeddingClient = {
  createEmbedding: async () => [],
};

function buildDeps() {
  return createRuntimeOrchestrationDeps({
    openaiClient,
    model: "test-model",
    embeddingModel: "test-embedding-model",
    rpc,
    embeddingClient,
  });
}

test("agent-first production bootstrap removes every legacy shadow/model contour while legacy keeps rollback wiring", () => {
  const previousMode = process.env.RUNTIME_AGENT_MODE;
  try {
    process.env.RUNTIME_AGENT_MODE = "agent_first";
    const agentFirst = buildDeps();
    assert.equal(agentFirst.runtimeGateClassifier, undefined);
    assert.equal(agentFirst.turnUnderstandingClassifier, undefined);
    assert.equal(agentFirst.caseRouterClassifier, undefined);
    assert.equal(agentFirst.caseLiteExtractor, undefined);
    assert.equal(agentFirst.caseContextRepository, undefined);

    process.env.RUNTIME_AGENT_MODE = "legacy";
    const legacy = buildDeps();
    assert.ok(legacy.runtimeGateClassifier, "legacy keeps Runtime Gate shadow classifier wired");
    assert.ok(legacy.turnUnderstandingClassifier, "legacy keeps Turn Understanding shadow classifier wired");
    assert.ok(legacy.caseRouterClassifier, "legacy keeps case router rollback wiring");
    assert.ok(legacy.caseLiteExtractor, "legacy keeps case-lite rollback wiring");
    assert.ok(legacy.caseContextRepository, "legacy keeps case context rollback wiring");
  } finally {
    if (previousMode === undefined) delete process.env.RUNTIME_AGENT_MODE;
    else process.env.RUNTIME_AGENT_MODE = previousMode;
  }
});

test("classifier-derived topic_memory is not patient-facing model context", () => {
  const projected = buildModelVisibleRuntimeContext({
    known_contact: {},
    conversation_state: {},
    recent_history: [],
    topic_memory: {
      last_service_interest: "implant",
      updated_at: "2026-08-23T00:00:00.000Z",
      source: "turn_understanding",
      confidence: "high",
    },
  });

  assert.equal("topic_memory" in projected, false);
  assert.deepEqual((projected.task_state as Record<string, unknown>).collected, {});
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRuntimeTurnResult,
  shouldPreserveConversationAfterFirstCallRateLimit,
} from "../src/runtime/runtimeTurnService.ts";
import type { RuntimeAgentTurnResult } from "../src/runtime/openaiRuntimeAgent.ts";

function failedTurn(overrides: Partial<RuntimeAgentTurnResult> = {}): RuntimeAgentTurnResult {
  return {
    final_patient_reply: "Извините, сейчас не удалось обработать сообщение.",
    conversation_id: "conv-existing",
    conversation_id_resumable: false,
    tool_requests: [],
    tool_results: [],
    debug: {
      reason: "agent_first_call_exception",
      caller_exception: {
        stage: "first_call",
        error_code: 429,
      },
    },
    ...overrides,
  };
}

test("exhausted first-call 429 preserves the existing conversation", () => {
  const result = failedTurn();
  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), true);

  const normalized = normalizeRuntimeTurnResult(result);
  assert.equal(normalized.conversation_id, "conv-existing");
  assert.equal(normalized.conversation_id_resumable, true);
});

test("rate_limit_exceeded string code is also recognized", () => {
  const result = failedTurn({
    debug: {
      reason: "agent_first_call_exception",
      caller_exception: {
        stage: "first_call",
        error_code: "rate_limit_exceeded",
      },
    },
  });
  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), true);
});

test("second-call 429 remains non-resumable because a tool call may be pending", () => {
  const result = failedTurn({
    tool_requests: [{ tool: "availability.check", call_id: "a1", arguments: { requested_date: "2026-08-25" } }],
    debug: {
      reason: "agent_second_call_exception_generic_fallback",
      caller_exception: {
        stage: "second_call",
        error_code: 429,
      },
    },
  });

  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), false);
  assert.equal(normalizeRuntimeTurnResult(result).conversation_id_resumable, false);
});

test("first-call 500 remains non-resumable because outcome is not an explicit rejected 429", () => {
  const result = failedTurn({
    debug: {
      reason: "agent_first_call_exception",
      caller_exception: {
        stage: "first_call",
        error_code: 500,
      },
    },
  });

  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), false);
  assert.equal(normalizeRuntimeTurnResult(result).conversation_id_resumable, false);
});

test("first-call 429 without a prior conversation cannot preserve one", () => {
  const result = failedTurn({ conversation_id: null });
  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), false);
});

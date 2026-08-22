import assert from "node:assert/strict";
import test from "node:test";

import { buildCallerExceptionDiagnostics } from "../src/runtime/callerExceptionDiagnostics.ts";
import {
  normalizeRuntimeTurnResult,
  shouldPreserveConversationAfterFirstCallRateLimit,
} from "../src/runtime/runtimeTurnService.ts";
import type { RuntimeAgentTurnResult } from "../src/runtime/openaiRuntimeAgent.ts";

const SINGLE_ATTEMPT_POLICY = {
  single_attempt_first_call_rate_limit_safe: true,
} as const;

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

test("eligible first-call 429 preserves the existing conversation when single-attempt safety is explicit", () => {
  const result = failedTurn();
  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), true);

  const normalized = normalizeRuntimeTurnResult(result, SINGLE_ATTEMPT_POLICY);
  assert.equal(normalized.conversation_id, "conv-existing");
  assert.equal(normalized.conversation_id_resumable, true);
});

test("generic normalization fails closed without explicit single-attempt safety", () => {
  const result = failedTurn();
  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), true);
  assert.equal(normalizeRuntimeTurnResult(result).conversation_id_resumable, false);
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

test("HTTP 429 is preserved when provider semantic code is insufficient_quota", () => {
  const error = Object.assign(new Error("quota exhausted"), {
    code: "insufficient_quota",
    status: 429,
  });
  const callerException = buildCallerExceptionDiagnostics(error, {
    stage: "first_call",
    conversationId: "conv-existing",
  });

  assert.equal(callerException.error_code, "insufficient_quota");
  assert.equal(callerException.http_status, 429);

  const result = failedTurn({
    debug: {
      reason: "agent_first_call_exception",
      caller_exception: callerException,
    },
  });

  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), true);
  assert.equal(
    normalizeRuntimeTurnResult(result, SINGLE_ATTEMPT_POLICY).conversation_id_resumable,
    true,
  );
});

test("semantic quota code without HTTP 429 does not prove a safe rejected rate-limit call", () => {
  const result = failedTurn({
    debug: {
      reason: "agent_first_call_exception",
      caller_exception: {
        stage: "first_call",
        error_code: "insufficient_quota",
        http_status: 400,
      },
    },
  });

  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), false);
  assert.equal(
    normalizeRuntimeTurnResult(result, SINGLE_ATTEMPT_POLICY).conversation_id_resumable,
    false,
  );
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
  assert.equal(
    normalizeRuntimeTurnResult(result, SINGLE_ATTEMPT_POLICY).conversation_id_resumable,
    false,
  );
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
  assert.equal(
    normalizeRuntimeTurnResult(result, SINGLE_ATTEMPT_POLICY).conversation_id_resumable,
    false,
  );
});

test("first-call 429 without a prior conversation cannot preserve one", () => {
  const result = failedTurn({ conversation_id: null });
  assert.equal(shouldPreserveConversationAfterFirstCallRateLimit(result), false);
});

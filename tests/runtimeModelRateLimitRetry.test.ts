import assert from "node:assert/strict";
import test from "node:test";

import {
  invokeRuntimeModelCall,
  isRuntimeModelRateLimitError,
  type RuntimeAgentCaller,
} from "../src/runtime/runtimeModelCall.ts";

function baseParams(caller: RuntimeAgentCaller) {
  return {
    caller,
    model: "test-model",
    conversation_id: "conv-1",
    system_instruction: "test",
    message: "hello",
    context: {},
  };
}

test("detects OpenAI 429 status and nested rate_limit_exceeded code", () => {
  assert.equal(isRuntimeModelRateLimitError({ status: 429 }), true);
  assert.equal(isRuntimeModelRateLimitError({ error: { code: "rate_limit_exceeded" } }), true);
  assert.equal(isRuntimeModelRateLimitError({ status: 500 }), false);
});

test("retries 429 twice and returns the successful model result", async () => {
  let calls = 0;
  const waits: number[] = [];
  const caller: RuntimeAgentCaller = async () => {
    calls += 1;
    if (calls < 3) throw { status: 429 };
    return {
      type: "final_response",
      conversation_id: "conv-2",
      final_response: { final_patient_reply: "ok" },
    };
  };

  const result = await invokeRuntimeModelCall({
    ...baseParams(caller),
    retry_policy: {
      max_attempts: 3,
      base_delay_ms: 100,
      max_delay_ms: 1_000,
      sleep: async (ms) => { waits.push(ms); },
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.conversation_id, "conv-2");
    assert.equal(result.output.type, "final_response");
  }
});

test("honors Retry-After and clamps it to configured max delay", async () => {
  let calls = 0;
  const waits: number[] = [];
  const caller: RuntimeAgentCaller = async () => {
    calls += 1;
    if (calls === 1) {
      throw { status: 429, headers: { "retry-after": "10" } };
    }
    return {
      type: "final_response",
      final_response: { final_patient_reply: "ok" },
    };
  };

  const result = await invokeRuntimeModelCall({
    ...baseParams(caller),
    retry_policy: {
      max_attempts: 2,
      base_delay_ms: 50,
      max_delay_ms: 500,
      sleep: async (ms) => { waits.push(ms); },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [500]);
});

test("does not retry non-429 failures with unknown upstream outcome", async () => {
  let calls = 0;
  const waits: number[] = [];
  const failure = { status: 500, message: "server error" };
  const caller: RuntimeAgentCaller = async () => {
    calls += 1;
    throw failure;
  };

  const result = await invokeRuntimeModelCall({
    ...baseParams(caller),
    retry_policy: {
      max_attempts: 3,
      sleep: async (ms) => { waits.push(ms); },
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, failure);
});

test("returns the final 429 after retry budget is exhausted", async () => {
  let calls = 0;
  const waits: number[] = [];
  const caller: RuntimeAgentCaller = async () => {
    calls += 1;
    throw { status: 429, sequence: calls };
  };

  const result = await invokeRuntimeModelCall({
    ...baseParams(caller),
    retry_policy: {
      max_attempts: 3,
      base_delay_ms: 25,
      max_delay_ms: 100,
      sleep: async (ms) => { waits.push(ms); },
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 50]);
  assert.equal(result.ok, false);
});

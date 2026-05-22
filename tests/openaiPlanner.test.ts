import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlannerSystemInstruction,
  createOpenAIPlanner,
  type OpenAIPlannerCallerInput,
} from "../src/runtime/openaiPlanner.ts";

test("planner calls injected caller with model and messages", async () => {
  let received: OpenAIPlannerCallerInput | null = null;

  const planner = createOpenAIPlanner({
    model: "gpt-test",
    caller: async (input) => {
      received = input;
      return { output: { turn_type: "unknown" } };
    },
  });

  const result = await planner.plan({
    clinic_id: "clinic-1",
    user_message: "I need a cleaning next week",
  });

  assert.equal(result.model, "gpt-test");
  assert.deepEqual(result.raw_planner_output, { turn_type: "unknown" });
  assert.ok(received);
  assert.equal(received?.model, "gpt-test");
  assert.equal(received?.messages.length, 2);
  assert.equal(received?.messages[0]?.role, "system");
  assert.equal(received?.messages[1]?.role, "user");
  assert.match(received?.messages[1]?.content ?? "", /clinic-1/);
});

test("planner passes conversation_id when provided", async () => {
  let receivedConversationId: string | null | undefined;

  const planner = createOpenAIPlanner({
    model: "gpt-test",
    caller: async (input) => {
      receivedConversationId = input.conversation_id;
      return { output: { ok: true } };
    },
  });

  await planner.plan({
    clinic_id: "clinic-1",
    user_message: "hello",
    conversation_id: "conv-123",
  });

  assert.equal(receivedConversationId, "conv-123");
});

test("planner returns new conversation_id when caller returns one", async () => {
  const planner = createOpenAIPlanner({
    model: "gpt-test",
    caller: async () => ({
      output: { ok: true },
      conversation_id: "conv-new-456",
      usage: { tokens: 123 },
    }),
  });

  const result = await planner.plan({
    clinic_id: "clinic-1",
    user_message: "hello",
  });

  assert.equal(result.conversation_id, "conv-new-456");
  assert.deepEqual(result.usage, { tokens: 123 });
});

test("system instructions include planner guardrails and memory boundary", () => {
  const instruction = buildPlannerSystemInstruction({
    clinic_id: "clinic-1",
    user_message: "hi",
  });

  assert.match(instruction, /Return JSON only/i);
  assert.match(instruction, /Never request admin\.notify/i);
  assert.match(instruction, /kb\.search/);
  assert.match(instruction, /availability\.check/);
  assert.match(instruction, /hold\.create/);
  assert.match(instruction, /booking\.confirm/);
  assert.match(instruction, /cancel_hold/);
  assert.match(instruction, /appointment\.mutate/);
  assert.match(instruction, /Never claim booking is confirmed/i);
  assert.match(instruction, /dialogue continuity only/i);
  assert.match(instruction, /runtime context and Supabase\/Postgres/i);
});

test("planner returns raw_planner_output without parsing", async () => {
  const raw = { non_planner_shape: true, nested: { any: "thing" } };
  const planner = createOpenAIPlanner({
    model: "gpt-test",
    caller: async () => ({ output: raw }),
  });

  const result = await planner.plan({
    clinic_id: "clinic-1",
    user_message: "free form",
  });

  assert.equal(result.raw_planner_output, raw);
});

test("planner boundary has no parser/policy/executor/repository side effects", async () => {
  let callCount = 0;
  const planner = createOpenAIPlanner({
    model: "gpt-test",
    caller: async () => {
      callCount += 1;
      return { output: { turn_type: "unknown" } };
    },
  });

  await planner.plan({ clinic_id: "clinic-1", user_message: "hello" });
  assert.equal(callCount, 1);
});

test("openai planner module does not import forbidden integrations", async () => {
  const moduleSource = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/runtime/openaiPlanner.ts", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(moduleSource, /import .*supabase/i);
  assert.doesNotMatch(moduleSource, /import .*telegram/i);
  assert.doesNotMatch(moduleSource, /import .*n8n/i);
  assert.doesNotMatch(moduleSource, /import .*calendar/i);
  assert.doesNotMatch(moduleSource, /parsePlannerOutput/);
  assert.doesNotMatch(moduleSource, /applyToolPolicy/);
});

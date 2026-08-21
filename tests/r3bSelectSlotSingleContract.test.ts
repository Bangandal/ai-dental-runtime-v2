import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";
import { buildOpenAIToolDefinitions } from "../src/runtime/openaiRuntimeAgentCaller.ts";

function callerInput() {
  return {
    model: "gpt-test",
    conversation_id: "conv_r3b",
    system_instruction: "system",
    input: {
      message: "14:00 подходит",
      context: { runtime_context: null },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  };
}

test("R3b source contract: booking.select_slot is semantic date/time only", () => {
  const def = RUNTIME_AGENT_TOOL_DEFINITIONS["booking.select_slot"];
  assert.deepEqual(def.required_args, ["requested_date", "requested_time"]);
  assert.deepEqual(def.optional_args, []);
  assert.doesNotMatch(def.description, /subject_id|subject_[1-4]/i);
  assert.match(def.description, /active patient/i);
});

test("R3b OpenAI projection is identical to the canonical select-slot contract", () => {
  const openAI = buildOpenAIToolDefinitions(callerInput() as never)
    .find((def) => def.name === "booking_select_slot") as Record<string, any> | undefined;
  assert.ok(openAI);
  assert.equal(openAI.description, RUNTIME_AGENT_TOOL_DEFINITIONS["booking.select_slot"].description);
  assert.deepEqual(openAI.parameters.required, ["requested_date", "requested_time"]);
  assert.equal("subject_id" in openAI.parameters.properties, false);
});

test("R3b caller no longer carries a second select-slot description/schema override", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "../src/runtime/openaiRuntimeAgentCaller.ts"), "utf8");
  assert.doesNotMatch(source, /SELECT_SLOT_MODEL_DESCRIPTION/);
  assert.doesNotMatch(source, /toolName === "booking\.select_slot"\s*\?\s*def\.required_args\.filter/);
});

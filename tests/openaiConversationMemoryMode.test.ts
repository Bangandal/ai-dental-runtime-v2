import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenAIInput } from "../src/runtime/openaiRuntimeAgentCaller.ts";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "../src/runtime/openaiRuntimeAgent.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "..");

test("openai runtime caller maps conversation_id to conversation", () => {
  const payload = buildOpenAIInput({
    model: "gpt-test",
    conversation_id: "conv_case_123",
    system_instruction: "system",
    input: {
      message: "hello",
      context: { clinic_id: "clinic_1", case_id: "case_1" },
      tool_definitions: RUNTIME_AGENT_TOOL_DEFINITIONS,
    },
  });

  assert.equal(payload.conversation, "conv_case_123");
});

test("openai runtime caller source does not use previous_response_id", async () => {
  const sourcePath = resolve(repoRoot, "src/runtime/openaiRuntimeAgentCaller.ts");
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /previous_response_id/);
});

test("conversation memory docs define conversation object mode and boundaries", async () => {
  const docsPath = resolve(repoRoot, "docs/OPENAI_CONVERSATION_MEMORY_PERSISTENCE.md");
  const docs = await readFile(docsPath, "utf8");

  assert.match(docs, /conversation object mode/i);
  assert.match(docs, /conversation object id/i);
  assert.equal(docs.includes("previous_response_id"), true);
  assert.equal(docs.toLowerCase().includes("not"), true);
  assert.match(docs, /Per case/i);
  assert.match(docs, /dialogue continuity/i);
  assert.match(docs, /Supabase\/Postgres remains the source of truth for business state/i);
  assert.match(docs, /Deterministic tool outputs and DB\/RPC-validated data remain business truth/i);
});

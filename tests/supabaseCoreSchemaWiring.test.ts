import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

test("production Supabase client pins core schema for runtime RPCs", async () => {
  const source = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(source.includes('schema: "core"'), true);
});

test("conversation memory repository uses unqualified RPC names under core schema client", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supabaseOpenAIConversationMemoryRepository.ts", import.meta.url),
    "utf8",
  );

  assert.equal(source.includes('"rpc_get_openai_conversation_memory_v1"'), true);
  assert.equal(source.includes('"rpc_upsert_openai_conversation_memory_v1"'), true);
  assert.equal(source.includes('"core.rpc_get_openai_conversation_memory_v1"'), false);
  assert.equal(source.includes('"core.rpc_upsert_openai_conversation_memory_v1"'), false);
});

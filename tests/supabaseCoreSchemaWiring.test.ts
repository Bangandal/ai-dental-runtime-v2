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

test("runtime repository RPC names are schema-compatible after core client pin", async () => {
  const [availabilitySource, knowledgeSource] = await Promise.all([
    fs.readFile(new URL("../src/runtime/supabaseAvailabilityRepository.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/runtime/supabaseKnowledgeRepository.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(availabilitySource.includes('"rpc_check_availability_v1"'), true);
  assert.equal(availabilitySource.includes('"public.rpc_check_availability_v1"'), false);
  assert.equal(availabilitySource.includes('"core.rpc_check_availability_v1"'), false);

  assert.equal(knowledgeSource.includes('\"rpc_kb_search_v1\"'), true);
  assert.equal(knowledgeSource.includes('\"public.rpc_kb_search_v1\"'), false);
  assert.equal(knowledgeSource.includes('"core.rpc_kb_search_v1"'), false);
});

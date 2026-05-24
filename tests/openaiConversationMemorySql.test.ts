import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("openai conversation memory SQL defines table indexes and RPCs", async () => {
  const source = await readFile(new URL("../sql/rpc/core.openai_conversation_memory.sql", import.meta.url), "utf8");

  assert.equal(source.includes("create table if not exists core.openai_conversation_memory"), true);
  assert.equal(source.includes("openai_conversation_memory_identity_check"), true);
  assert.equal(source.includes("openai_conversation_memory_unique_external_user"), true);
  assert.equal(source.includes("openai_conversation_memory_unique_chat"), true);
  assert.equal(source.includes("openai_conversation_memory_conversation_id_idx"), true);
  assert.equal(source.includes("core.rpc_get_openai_conversation_memory_v1"), true);
  assert.equal(source.includes("core.rpc_upsert_openai_conversation_memory_v1"), true);
});

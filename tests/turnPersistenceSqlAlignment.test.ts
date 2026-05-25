import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const REPO_PATH = new URL("../src/runtime/supabaseTurnPersistenceRepository.ts", import.meta.url);
const DOC_PATH = new URL("../docs/RUNTIME_DB_PERSISTENCE.md", import.meta.url);

test("no turn-persistence SQL stub file exists", async () => {
  await assert.rejects(fs.stat(new URL("../sql/rpc/core.rpc_turn_persistence.sql", import.meta.url)));
});

test("repository keeps intended RPC names and does not use stub-only args", async () => {
  const repo = await fs.readFile(REPO_PATH, "utf8");
  for (const rpcName of [
    "rpc_get_or_create_contact",
    "rpc_register_inbound_event",
    "rpc_save_message",
    "rpc_merge_conversation_state",
    "rpc_get_recent_messages_v1",
  ]) {
    assert.equal(repo.includes(rpcName), true, `missing repo RPC call: ${rpcName}`);
  }
  for (const requiredParam of [
    "p_clinic_code",
    "p_dedupe_key",
    "p_source_message_id",
    "p_direction",
    "p_message_type",
    "p_user_text",
    "p_reply_text",
  ]) {
    assert.equal(repo.includes(requiredParam), true, `missing expected RPC param mapping: ${requiredParam}`);
  }
  assert.equal(repo.includes("p_state_json"), false);
  assert.equal(repo.includes("p_patch"), false);
});

test("recent messages SQL RPC exists with expected ordering and limit", async () => {
  const sql = await fs.readFile(new URL("../sql/rpc/core.rpc_get_recent_messages_v1.sql", import.meta.url), "utf8");
  assert.equal(sql.includes("create or replace function core.rpc_get_recent_messages_v1"), true);
  assert.equal(sql.includes("order by m.created_at desc"), true);
  assert.equal(sql.includes("limit greatest(p_limit, 1)"), true);
});

test("docs explicitly record missing SQL definitions in this repository", async () => {
  const doc = await fs.readFile(DOC_PATH, "utf8");
  assert.equal(doc.includes("Missing SQL in this repo"), true);
  assert.equal(doc.includes("do not add SQL stubs"), true);
});

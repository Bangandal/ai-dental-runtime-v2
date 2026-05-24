import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const SQL_PATH = new URL("../sql/rpc/core.rpc_turn_persistence.sql", import.meta.url);
const REPO_PATH = new URL("../src/runtime/supabaseTurnPersistenceRepository.ts", import.meta.url);

test("turn persistence RPC names exist in SQL file", async () => {
  const sql = await fs.readFile(SQL_PATH, "utf8");
  for (const name of [
    "rpc_get_or_create_contact",
    "rpc_register_inbound_event",
    "rpc_save_message",
    "rpc_merge_conversation_state",
  ]) {
    assert.equal(sql.includes(name), true, `missing SQL RPC: ${name}`);
  }
});

test("turn persistence repository argument names align with SQL p_* params", async () => {
  const [sql, repo] = await Promise.all([fs.readFile(SQL_PATH, "utf8"), fs.readFile(REPO_PATH, "utf8")]);

  for (const param of [
    "p_clinic_id",
    "p_channel",
    "p_external_user_id",
    "p_chat_id",
    "p_username",
    "p_first_name",
    "p_last_name",
    "p_contact_id",
    "p_trace_id",
    "p_raw_payload",
    "p_role",
    "p_text",
    "p_state_json",
  ]) {
    assert.equal(sql.includes(param), true, `missing SQL param: ${param}`);
  }

  assert.equal(repo.includes("p_state_json"), true);
  assert.equal(repo.includes("p_patch"), false);
});

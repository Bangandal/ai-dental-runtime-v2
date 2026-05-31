import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

test("public.rpc_kb_search_v1 delegates to kb retrieval rpc", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/public.rpc_kb_search_v1.sql", import.meta.url), "utf8")).toLowerCase();
  assert.equal(source.includes("kb.rpc_retrieve_context_json"), true);
});

test("core.rpc_kb_search_v1 delegates to kb retrieval rpc", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/core.rpc_kb_search_v1.sql", import.meta.url), "utf8")).toLowerCase();
  assert.equal(source.includes("kb.rpc_retrieve_context_json"), true);
});

test("public.rpc_check_availability_v1 is read-only and does not use booking apply rpc", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/public.rpc_check_availability_v1.sql", import.meta.url), "utf8")).toLowerCase();
  for (const blocked of ["insert", "update", "delete", "core.rpc_apply_booking_decision_v1", "core.rpc_check_availability_v1("]) {
    assert.equal(source.includes(blocked), false);
  }
});

test("alignment doc states UUID requirement for clinic_id in runtime path", async () => {
  const source = await fs.readFile(new URL("../docs/RUNTIME_SUPABASE_RPC_ALIGNMENT.md", import.meta.url), "utf8");
  assert.equal(source.includes("clinic_code"), true);
  assert.equal(source.includes("real clinic UUID"), true);
});


test("public.rpc_merge_conversation_state delegates to core merge rpc", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/public.rpc_merge_conversation_state.sql", import.meta.url), "utf8")).toLowerCase();
  assert.equal(source.includes("core.rpc_merge_conversation_state"), true);
});

test("core.rpc_merge_conversation_state persists typed topic_memory without broad control flag merge", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/core.rpc_merge_conversation_state.sql", import.meta.url), "utf8")).toLowerCase();

  assert.equal(source.includes("jsonb_typeof(v_control_flags->'topic_memory') = 'object'"), true);
  assert.equal(source.includes("jsonb_set(v_next_state, '{topic_memory}', v_control_flags->'topic_memory', true)"), true);
  assert.equal(source.includes("coalesce(v_existing_state, '{}'::jsonb)"), true);
  assert.equal(source.includes("v_next_state || v_control_flags"), false);
});

test("core.rpc_merge_conversation_state preserves known state merge behaviors", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/core.rpc_merge_conversation_state.sql", import.meta.url), "utf8")).toLowerCase();

  assert.equal(source.includes("jsonb_set(v_next_state, '{openai_conversation_id}'"), true);
  assert.equal(source.includes("jsonb_set(v_next_state, '{conversation_id}'"), true);
  assert.equal(source.includes(`jsonb_set(
      v_next_state,
      '{collected}'`), true);
  assert.equal(source.includes("jsonb_set(v_next_state, '{missing_fields}'"), true);
  assert.equal(source.includes(`jsonb_set(
      v_next_state,
      '{task_state}'`), true);
});

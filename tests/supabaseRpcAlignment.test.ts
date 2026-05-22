import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

test("public.rpc_kb_search_v1 delegates to kb retrieval rpc", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/public.rpc_kb_search_v1.sql", import.meta.url), "utf8")).toLowerCase();
  assert.equal(source.includes("kb.rpc_retrieve_context_json"), true);
});

test("public.rpc_check_availability_v1 is read-only and does not use booking apply rpc", async () => {
  const source = (await fs.readFile(new URL("../sql/rpc/public.rpc_check_availability_v1.sql", import.meta.url), "utf8")).toLowerCase();
  for (const blocked of ["insert", "update", "delete", "core.rpc_apply_booking_decision_v1"]) {
    assert.equal(source.includes(blocked), false);
  }
});

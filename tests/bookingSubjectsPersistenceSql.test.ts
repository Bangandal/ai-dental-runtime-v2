import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("SQL contract: merge RPC persists booking_subjects as a guarded top-level state object", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(thisDir, "../sql/rpc/core.rpc_merge_conversation_state.sql");
  const sql = await readFile(sqlPath, "utf8");

  assert.ok(
    sql.includes("jsonb_typeof(v_control_flags->'booking_subjects') = 'object'"),
    "booking_subjects must only be accepted when the incoming control flag is a JSON object",
  );
  assert.ok(
    sql.includes("'{booking_subjects}'"),
    "booking_subjects must be written to state_json.booking_subjects",
  );
  assert.ok(
    sql.includes("v_control_flags->'booking_subjects'"),
    "the real RPC must persist the booking_subjects value passed by TypeScript",
  );
});

test("SQL contract: merge RPC preserves existing state before targeted booking_subjects replacement", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(thisDir, "../sql/rpc/core.rpc_merge_conversation_state.sql");
  const sql = await readFile(sqlPath, "utf8");

  assert.ok(
    sql.includes("v_next_state := coalesce(v_existing_state, '{}'::jsonb)"),
    "merge RPC must start from the existing state instead of rebuilding only a fixed whitelist",
  );

  const guardIndex = sql.indexOf("jsonb_typeof(v_control_flags->'booking_subjects') = 'object'");
  const writeIndex = sql.indexOf("'{booking_subjects}'", guardIndex);
  assert.ok(guardIndex >= 0 && writeIndex > guardIndex, "booking_subjects write must remain inside the object-type guard");
});

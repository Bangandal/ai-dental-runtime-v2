import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const SQL_PATH = new URL("../sql/rpc/core.rpc_check_availability_v1.sql", import.meta.url);
const DOC_PATH = new URL("../docs/RPC_CHECK_AVAILABILITY_V1.md", import.meta.url);

test("rpc_check_availability_v1 SQL exists and is read-only declared", async () => {
  const sql = await fs.readFile(SQL_PATH, "utf8");

  const required = [
    "create or replace function core.rpc_check_availability_v1",
    "READ-ONLY RPC",
    "safe for Runtime V2 availability.check",
    "stable",
    "returns table",
    "core.slot_holds",
    "core.appointments",
  ];

  for (const phrase of required) {
    assert.equal(sql.includes(phrase), true, `Missing required phrase: ${phrase}`);
  }

  const forbidden = [" insert ", " update ", " delete ", "call core.rpc_apply_booking_decision_v1"];
  const normalized = ` ${sql.toLowerCase().replace(/\s+/g, " ")} `;
  for (const phrase of forbidden) {
    assert.equal(normalized.includes(phrase), false, `Unexpected mutating phrase: ${phrase}`);
  }
});

test("availability RPC doc exists and explains read/write split", async () => {
  const doc = await fs.readFile(DOC_PATH, "utf8");
  const required = [
    "availability.check",
    "hold.create",
    "booking.confirm",
    "cancel_hold",
    "rpc_apply_booking_decision_v1",
    "no state mutations",
  ];

  for (const phrase of required) {
    assert.equal(doc.includes(phrase), true, `Missing required phrase: ${phrase}`);
  }
});

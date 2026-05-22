import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseAvailabilityRepository, type RpcCaller } from "../src/runtime/supabaseAvailabilityRepository.ts";

test("calls rpc_check_availability_v1 with mapped arguments", async () => {
  let calledName = "";
  let calledArgs: Record<string, unknown> | null = null;

  const rpc: RpcCaller = async (functionName, args) => {
    calledName = functionName;
    calledArgs = args;
    return { data: [], error: null };
  };

  const repo = createSupabaseAvailabilityRepository({ rpc });
  await repo.checkAvailability({
    clinic_id: "clinic_1",
    requested_date: "2026-06-01",
    requested_time: "09:30",
    service_interest: "cleaning",
    timezone: "America/New_York",
    limit: 3,
  });

  assert.equal(calledName, "rpc_check_availability_v1");
  assert.deepEqual(calledArgs, {
    p_clinic_id: "clinic_1",
    p_service_interest: "cleaning",
    p_requested_date: "2026-06-01",
    p_requested_time: "09:30",
    p_timezone: "America/New_York",
    p_limit: 3,
  });
});

test("normalizes rows into RpcAvailabilitySlot[]", async () => {
  const rpc: RpcCaller = async () => ({
    data: [
      {
        slot_key: "slot_1",
        starts_at: "2026-06-01T09:30:00Z",
        ends_at: "2026-06-01T10:00:00Z",
        doctor_id: "doc_1",
        timezone: "America/New_York",
      },
    ],
    error: null,
  });

  const repo = createSupabaseAvailabilityRepository({ rpc });
  const result = await repo.checkAvailability({ clinic_id: "clinic_1", requested_date: "2026-06-01" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data, {
      slots: [
        {
          slot_id: "slot_1",
          starts_at: "2026-06-01T09:30:00Z",
          ends_at: "2026-06-01T10:00:00Z",
          provider_id: "doc_1",
          service_id: null,
          timezone: "America/New_York",
        },
      ],
      timezone: "America/New_York",
    });
  }
});

test("returns empty slots on null or empty data", async () => {
  const rpcNull: RpcCaller = async () => ({ data: null, error: null });
  const repoNull = createSupabaseAvailabilityRepository({ rpc: rpcNull });
  const fromNull = await repoNull.checkAvailability({ clinic_id: "clinic_1", requested_date: "2026-06-01" });
  assert.deepEqual(fromNull, { ok: true, data: { slots: [] } });

  const rpcEmpty: RpcCaller = async () => ({ data: [], error: null });
  const repoEmpty = createSupabaseAvailabilityRepository({ rpc: rpcEmpty });
  const fromEmpty = await repoEmpty.checkAvailability({ clinic_id: "clinic_1", requested_date: "2026-06-01" });
  assert.deepEqual(fromEmpty, { ok: true, data: { slots: [], timezone: null } });
});

test("returns failure on RPC error", async () => {
  const rpc: RpcCaller = async () => ({ data: null, error: new Error("boom") });
  const repo = createSupabaseAvailabilityRepository({ rpc });

  const result = await repo.checkAvailability({ clinic_id: "clinic_1", requested_date: "2026-06-01" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "availability_rpc_error");
    assert.equal(result.error.retryable, true);
  }
});

test("fails malformed rows", async () => {
  const rpc: RpcCaller = async () => ({
    data: [{ slot_key: "slot_1", starts_at: "2026-06-01T09:30:00Z" }],
    error: null,
  });
  const repo = createSupabaseAvailabilityRepository({ rpc });

  const result = await repo.checkAvailability({ clinic_id: "clinic_1", requested_date: "2026-06-01" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "availability_rpc_malformed_response");
  }
});

test("adapter source enforces read-only boundaries", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../src/runtime/supabaseAvailabilityRepository.ts", import.meta.url), "utf8");

  assert.equal(source.includes("rpc_check_availability_v1"), true);
  assert.equal(source.includes("rpc_apply_booking_decision_v1"), false);

  const lowered = source.toLowerCase();
  for (const blockedWord of ["n8n", "telegram", "openai", "calendar"]) {
    assert.equal(lowered.includes(blockedWord), false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseRowMissingIdError,
  createSupabaseCaseRepository,
} from "../src/runtime/supabaseCaseRepository.ts";
import type { RpcCaller } from "../src/runtime/runtimeRepositories.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRpc(openCases: unknown[]): RpcCaller {
  return async (_fn, _args) => ({
    data: [{ open_cases: openCases }] as unknown[],
    error: null,
  });
}

function makeRawCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    case_id: "case-001",
    case_type: "booking_intake",
    status: "collecting",
    opened_at: "2026-06-24T10:00:00Z",
    last_activity_at: "2026-06-24T10:05:00Z",
    closed_at: null,
    collected: {
      conversation_id: "conv-abc",
      subject_kind: "self",
      subject_display_name: "Mikhail",
      subject_relation: null,
      service_interest: "cleaning",
      preferred_date: "2026-07-01",
      preferred_time: "10:00",
      urgency: false,
      handoff_reason: null,
      notes: null,
      outcome: null,
    },
    meta: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getActiveCases — normalization
// ---------------------------------------------------------------------------

test("getActiveCases: normalizes open_cases JSON to Case[]", async () => {
  const rpc = makeRpc([makeRawCase()]);
  const repo = createSupabaseCaseRepository({ rpc });

  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.length, 1);
  const c = result.data[0];
  assert.equal(c.case_id, "case-001");
  assert.equal(c.clinic_id, "clinic-1");
  assert.equal(c.contact_id, "contact-1");
  assert.equal(c.case_kind, "booking_intake");
  assert.equal(c.status, "collecting");
  assert.equal(c.subject_kind, "self");
  assert.equal(c.subject_display_name, "Mikhail");
  assert.equal(c.service_interest, "cleaning");
  assert.equal(c.preferred_date, "2026-07-01");
  assert.equal(c.preferred_time, "10:00");
  assert.equal(c.urgency, false);
  assert.equal(c.created_at, "2026-06-24T10:00:00Z");
  assert.equal(c.updated_at, "2026-06-24T10:05:00Z");
  assert.equal(c.closed_at, null);
});

// ---------------------------------------------------------------------------
// case_id resolution
// ---------------------------------------------------------------------------

test("getActiveCases: accepts row.case_id as primary case_id source", async () => {
  const rpc = makeRpc([makeRawCase({ case_id: "primary-id", id: "fallback-id" })]);
  const repo = createSupabaseCaseRepository({ rpc });

  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_id, "primary-id");
});

test("getActiveCases: accepts row.id as fallback when case_id is absent", async () => {
  const raw = makeRawCase();
  delete (raw as Record<string, unknown>).case_id;
  (raw as Record<string, unknown>).id = "fallback-id";
  const rpc = makeRpc([raw]);
  const repo = createSupabaseCaseRepository({ rpc });

  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_id, "fallback-id");
});

test("getActiveCases: throws CaseRowMissingIdError when both case_id and id are absent", async () => {
  const raw = makeRawCase();
  delete (raw as Record<string, unknown>).case_id;
  const rpc = makeRpc([raw]);
  const repo = createSupabaseCaseRepository({ rpc });

  await assert.rejects(
    () => repo.getActiveCases("clinic-1", "contact-1", "conv-abc"),
    CaseRowMissingIdError,
  );
});

// ---------------------------------------------------------------------------
// case_type → case_kind mapping
// ---------------------------------------------------------------------------

test("getActiveCases: maps case_type booking_intake to CaseKind booking_intake", async () => {
  const rpc = makeRpc([makeRawCase({ case_type: "booking_intake" })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_kind, "booking_intake");
});

test("getActiveCases: maps legacy case_type booking to CaseKind booking_intake", async () => {
  const rpc = makeRpc([makeRawCase({ case_type: "booking" })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_kind, "booking_intake");
});

test("getActiveCases: maps case_type urgent to CaseKind urgent", async () => {
  const rpc = makeRpc([makeRawCase({ case_type: "urgent" })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_kind, "urgent");
});

// ---------------------------------------------------------------------------
// jsonb field reading
// ---------------------------------------------------------------------------

test("getActiveCases: reads jsonb fields from collected (canonical)", async () => {
  const rpc = makeRpc([makeRawCase({
    collected: {
      conversation_id: "conv-abc",
      subject_kind: "friend",
      subject_display_name: "Vasya",
      subject_relation: "friend",
      service_interest: "implant",
      urgency: true,
      outcome: "handed_off",
    },
    meta: {},
  })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const c = result.data[0];
  assert.equal(c.subject_kind, "friend");
  assert.equal(c.subject_display_name, "Vasya");
  assert.equal(c.subject_relation, "friend");
  assert.equal(c.service_interest, "implant");
  assert.equal(c.urgency, true);
  assert.equal(c.outcome, "handed_off");
});

test("getActiveCases: falls back to meta when collected field is absent", async () => {
  const rpc = makeRpc([makeRawCase({
    collected: { conversation_id: "conv-abc" },
    meta: {
      subject_kind: "child",
      subject_display_name: "Little One",
      service_interest: "orthodontics",
      outcome: "answered",
    },
  })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const c = result.data[0];
  assert.equal(c.subject_kind, "child");
  assert.equal(c.subject_display_name, "Little One");
  assert.equal(c.service_interest, "orthodontics");
  assert.equal(c.outcome, "answered");
});

test("getActiveCases: collected takes precedence over meta when both have same field", async () => {
  const rpc = makeRpc([makeRawCase({
    collected: { conversation_id: "conv-abc", subject_kind: "self" },
    meta: { subject_kind: "partner" },
  })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].subject_kind, "self");
});

// ---------------------------------------------------------------------------
// conversation_id filtering
// ---------------------------------------------------------------------------

test("getActiveCases: filters by conversation_id from collected", async () => {
  const rpc = makeRpc([
    makeRawCase({ case_id: "case-abc", collected: { conversation_id: "conv-abc" } }),
    makeRawCase({ case_id: "case-xyz", collected: { conversation_id: "conv-xyz" } }),
  ]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].case_id, "case-abc");
});

test("getActiveCases: returns empty array when no cases match conversation_id", async () => {
  const rpc = makeRpc([
    makeRawCase({ collected: { conversation_id: "conv-other" } }),
  ]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.length, 0);
});

// ---------------------------------------------------------------------------
// findActiveCase filtering
// ---------------------------------------------------------------------------

test("findActiveCase: filters by case_kind", async () => {
  const rpc = makeRpc([
    makeRawCase({ case_id: "case-booking", case_type: "booking_intake", collected: { conversation_id: "conv-abc", subject_kind: "self" } }),
    makeRawCase({ case_id: "case-urgent", case_type: "urgent", collected: { conversation_id: "conv-abc", subject_kind: "self" } }),
  ]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.findActiveCase({
    clinic_id: "clinic-1",
    contact_id: "contact-1",
    conversation_id: "conv-abc",
    case_kind: "urgent",
    subject_kind: "self",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.data !== null);
  assert.equal(result.data?.case_id, "case-urgent");
});

test("findActiveCase: distinguishes self from friend subject (Mikhail vs Vasya)", async () => {
  const rpc = makeRpc([
    makeRawCase({
      case_id: "case-self",
      case_type: "booking_intake",
      collected: { conversation_id: "conv-abc", subject_kind: "self", subject_display_name: "Mikhail" },
    }),
    makeRawCase({
      case_id: "case-friend",
      case_type: "booking_intake",
      collected: { conversation_id: "conv-abc", subject_kind: "friend", subject_display_name: "Vasya" },
    }),
  ]);
  const repo = createSupabaseCaseRepository({ rpc });

  const selfResult = await repo.findActiveCase({
    clinic_id: "clinic-1",
    contact_id: "contact-1",
    conversation_id: "conv-abc",
    case_kind: "booking_intake",
    subject_kind: "self",
    subject_display_name: "Mikhail",
  });
  assert.equal(selfResult.ok, true);
  if (!selfResult.ok) return;
  assert.equal(selfResult.data?.case_id, "case-self");

  const friendResult = await repo.findActiveCase({
    clinic_id: "clinic-1",
    contact_id: "contact-1",
    conversation_id: "conv-abc",
    case_kind: "booking_intake",
    subject_kind: "friend",
    subject_display_name: "Vasya",
  });
  assert.equal(friendResult.ok, true);
  if (!friendResult.ok) return;
  assert.equal(friendResult.data?.case_id, "case-friend");
});

test("findActiveCase: returns null when no case matches", async () => {
  const rpc = makeRpc([
    makeRawCase({ case_type: "booking_intake", collected: { conversation_id: "conv-abc", subject_kind: "self" } }),
  ]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.findActiveCase({
    clinic_id: "clinic-1",
    contact_id: "contact-1",
    conversation_id: "conv-abc",
    case_kind: "urgent",
    subject_kind: "self",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data, null);
});

// ---------------------------------------------------------------------------
// RPC error propagation
// ---------------------------------------------------------------------------

test("getActiveCases: returns RuntimeResult error when RPC fails", async () => {
  const rpc: RpcCaller = async () => ({ data: null, error: { message: "connection refused" } });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_context_load_failed");
});

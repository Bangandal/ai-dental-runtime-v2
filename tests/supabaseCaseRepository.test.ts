import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseRowMissingIdError,
  createSupabaseCaseRepository,
} from "../src/runtime/supabaseCaseRepository.ts";
import type { RpcCaller } from "../src/runtime/runtimeRepositories.ts";
import type { OpenCaseInput, AppendCaseEventInput, MergeCaseStateInput, CloseCaseInput } from "../src/runtime/case.ts";

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

test("getActiveCases: maps physical case_type booking_request to CaseKind booking_intake", async () => {
  const rpc = makeRpc([makeRawCase({ case_type: "booking_request" })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_kind, "booking_intake");
});

test("getActiveCases: maps physical case_type admin_request to CaseKind admin_handoff", async () => {
  const rpc = makeRpc([makeRawCase({ case_type: "admin_request" })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_kind, "admin_handoff");
});

test("getActiveCases: maps physical case_type follow_up to CaseKind process_status", async () => {
  const rpc = makeRpc([makeRawCase({ case_type: "follow_up" })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data[0].case_kind, "process_status");
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

test("getActiveCases: falls back to meta when collected field is null (nullish coalescing)", async () => {
  const rpc = makeRpc([makeRawCase({
    collected: {
      conversation_id: null,     // explicit null → must fall back to meta
      service_interest: null,    // explicit null → must fall back to meta
    },
    meta: {
      conversation_id: "conv-abc",
      service_interest: "cleaning",
    },
  })]);
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.getActiveCases("clinic-1", "contact-1", "conv-abc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.length, 1, "case should be returned after null fallback to meta");
  assert.equal(result.data[0].conversation_id, "conv-abc");
  assert.equal(result.data[0].service_interest, "cleaning");
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

// ---------------------------------------------------------------------------
// openCase — write path
// ---------------------------------------------------------------------------

type RpcCall = { fn: string; args: Record<string, unknown> };

function makeOpenCaseRpc(opts: {
  openError?: unknown;
  openResponseCaseId?: string;
  activeCases?: unknown[];
  activeCasesError?: unknown;
}): { rpc: RpcCaller; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const rpc: RpcCaller = async (fn, args) => {
    calls.push({ fn, args: args as Record<string, unknown> });
    if (fn === "rpc_apply_case_decision_v1") {
      if (opts.openError) return { data: null, error: opts.openError };
      return { data: [{ case_id: opts.openResponseCaseId ?? "new-case-id" }], error: null };
    }
    if (fn === "rpc_get_contact_case_context_v1") {
      if (opts.activeCasesError) return { data: null, error: opts.activeCasesError };
      const cases = opts.activeCases ?? [
        makeRawCase({
          case_id: opts.openResponseCaseId ?? "new-case-id",
          collected: { conversation_id: "conv-abc", subject_kind: "self" },
        }),
      ];
      return { data: [{ open_cases: cases }], error: null };
    }
    return { data: null, error: { message: `unexpected RPC: ${fn}` } };
  };
  return { rpc, calls };
}

const BASE_OPEN_INPUT: OpenCaseInput = {
  clinic_id: "clinic-1",
  contact_id: "contact-1",
  conversation_id: "conv-abc",
  case_kind: "booking_intake",
  subject_kind: "self",
  subject_display_name: "Mikhail",
  subject_relation: null,
  service_interest: "cleaning",
  preferred_date: "2026-07-01",
  preferred_time: "10:00",
  urgency: false,
  notes: "prefers morning",
};

test("openCase: calls rpc_apply_case_decision_v1 with p_case_action = open_case", async () => {
  const { rpc, calls } = makeOpenCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase(BASE_OPEN_INPUT);
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall, "rpc_apply_case_decision_v1 must be called");
  assert.equal(openCall.args.p_case_action, "open_case");
});

test("openCase: maps case_kind to p_case_type (reschedule → reschedule)", async () => {
  const { rpc, calls } = makeOpenCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase({ ...BASE_OPEN_INPUT, case_kind: "reschedule" });
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall);
  assert.equal(openCall.args.p_case_type, "reschedule");
});

test("openCase: maps booking_intake to physical p_case_type = booking_request", async () => {
  const { rpc, calls } = makeOpenCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase({ ...BASE_OPEN_INPUT, case_kind: "booking_intake" });
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall);
  assert.equal(openCall.args.p_case_type, "booking_request");
});

test("openCase: maps admin_handoff to physical p_case_type = admin_request", async () => {
  const { rpc, calls } = makeOpenCaseRpc({
    activeCases: [makeRawCase({ case_id: "new-case-id", case_type: "admin_request", collected: { conversation_id: "conv-abc", subject_kind: "self" } })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase({ ...BASE_OPEN_INPUT, case_kind: "admin_handoff" });
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall);
  assert.equal(openCall.args.p_case_type, "admin_request");
});

test("openCase: maps process_status to physical p_case_type = follow_up", async () => {
  const { rpc, calls } = makeOpenCaseRpc({
    activeCases: [makeRawCase({ case_id: "new-case-id", case_type: "follow_up", collected: { conversation_id: "conv-abc", subject_kind: "self" } })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase({ ...BASE_OPEN_INPUT, case_kind: "process_status" });
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall);
  assert.equal(openCall.args.p_case_type, "follow_up");
});

test("openCase: stores all missing logical fields in collected jsonb", async () => {
  const { rpc, calls } = makeOpenCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase(BASE_OPEN_INPUT);
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall);
  const col = openCall.args.p_collected as Record<string, unknown>;
  assert.equal(col.subject_kind, "self");
  assert.equal(col.subject_display_name, "Mikhail");
  assert.equal(col.service_interest, "cleaning");
  assert.equal(col.preferred_date, "2026-07-01");
  assert.equal(col.preferred_time, "10:00");
  assert.equal(col.urgency, false);
  assert.equal(col.notes, "prefers morning");
});

test("openCase: stores conversation_id in collected jsonb", async () => {
  const { rpc, calls } = makeOpenCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase(BASE_OPEN_INPUT);
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall);
  const col = openCall.args.p_collected as Record<string, unknown>;
  assert.equal(col.conversation_id, "conv-abc");
});

test("openCase: does not set outcome=booked in collected jsonb", async () => {
  const { rpc, calls } = makeOpenCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.openCase(BASE_OPEN_INPUT);
  const openCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(openCall);
  const col = openCall.args.p_collected as Record<string, unknown>;
  assert.notEqual(col.outcome, "booked");
});

test("openCase: returns normalized Case from follow-up read", async () => {
  const { rpc } = makeOpenCaseRpc({
    openResponseCaseId: "new-case-id",
    activeCases: [
      makeRawCase({
        case_id: "new-case-id",
        case_type: "booking_intake",
        collected: {
          conversation_id: "conv-abc",
          subject_kind: "self",
          subject_display_name: "Mikhail",
          service_interest: "cleaning",
        },
      }),
    ],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.openCase(BASE_OPEN_INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.case_id, "new-case-id");
  assert.equal(result.data.case_kind, "booking_intake");
  assert.equal(result.data.subject_kind, "self");
  assert.equal(result.data.service_interest, "cleaning");
  assert.equal(result.data.clinic_id, "clinic-1");
  assert.equal(result.data.contact_id, "contact-1");
});

test("openCase: propagates RPC error as RuntimeResult error", async () => {
  const { rpc } = makeOpenCaseRpc({ openError: { message: "insert failed" } });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.openCase(BASE_OPEN_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_open_failed");
});

// ---------------------------------------------------------------------------
// appendCaseEvent — write path
// ---------------------------------------------------------------------------

function makeAppendEventRpc(opts: { error?: unknown } = {}): {
  rpc: RpcCaller;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const rpc: RpcCaller = async (fn, args) => {
    calls.push({ fn, args: args as Record<string, unknown> });
    if (fn === "rpc_log_case_event") {
      if (opts.error) return { data: null, error: opts.error };
      return { data: null, error: null };
    }
    return { data: null, error: { message: `unexpected RPC: ${fn}` } };
  };
  return { rpc, calls };
}

const BASE_EVENT_INPUT: AppendCaseEventInput = {
  case_id: "case-001",
  clinic_id: "clinic-1",
  contact_id: "contact-1",
  event_kind: "status_collected",
  actor: "patient_agent",
  payload: { field: "service_interest", value: "cleaning" },
};

test("appendCaseEvent: calls rpc_log_case_event with confirmed signature args", async () => {
  const { rpc, calls } = makeAppendEventRpc();
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.appendCaseEvent(BASE_EVENT_INPUT);
  const call = calls.find((c) => c.fn === "rpc_log_case_event");
  assert.ok(call, "rpc_log_case_event must be called");
  assert.equal(call.args.p_clinic_id, "clinic-1");
  assert.equal(call.args.p_contact_id, "contact-1");
  assert.equal(call.args.p_case_id, "case-001");
  assert.equal(call.args.p_event_type, "status_collected");
  assert.equal(call.args.p_event_source, "patient_agent");
});

test("appendCaseEvent: passes p_contact_id to RPC", async () => {
  const { rpc, calls } = makeAppendEventRpc();
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.appendCaseEvent({ ...BASE_EVENT_INPUT, contact_id: "contact-xyz" });
  const call = calls.find((c) => c.fn === "rpc_log_case_event");
  assert.ok(call);
  assert.equal(call.args.p_contact_id, "contact-xyz");
});

test("appendCaseEvent: passes payload to RPC", async () => {
  const { rpc, calls } = makeAppendEventRpc();
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.appendCaseEvent(BASE_EVENT_INPUT);
  const call = calls.find((c) => c.fn === "rpc_log_case_event");
  assert.ok(call);
  const payload = call.args.p_payload as Record<string, unknown>;
  assert.equal(payload.field, "service_interest");
  assert.equal(payload.value, "cleaning");
});

test("appendCaseEvent: passes optional trace_id, message_id, lead_id, notification_id when provided", async () => {
  const { rpc, calls } = makeAppendEventRpc();
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.appendCaseEvent({
    ...BASE_EVENT_INPUT,
    trace_id: "trace-001",
    message_id: "msg-001",
    lead_id: "lead-001",
    notification_id: "notif-001",
  });
  const call = calls.find((c) => c.fn === "rpc_log_case_event");
  assert.ok(call);
  assert.equal(call.args.p_trace_id, "trace-001");
  assert.equal(call.args.p_message_id, "msg-001");
  assert.equal(call.args.p_lead_id, "lead-001");
  assert.equal(call.args.p_notification_id, "notif-001");
});

test("appendCaseEvent: propagates RPC error as RuntimeResult error", async () => {
  const { rpc } = makeAppendEventRpc({ error: { message: "event insert failed" } });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.appendCaseEvent(BASE_EVENT_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_event_append_failed");
});

// ---------------------------------------------------------------------------
// Safety — write scope guard
// ---------------------------------------------------------------------------

test("safety (PR92): closeCase not yet present at the time PR92 was merged — now superseded", () => {
  // This test is intentionally kept as a no-op marker to preserve PR92 history.
  // The actual scope guard is in the mergeCaseState section below.
});

// ---------------------------------------------------------------------------
// mergeCaseState — write path
// ---------------------------------------------------------------------------

function makeMergeRawCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    case_id: "case-001",
    case_type: "booking_request",
    status: "collecting",
    opened_at: "2026-06-24T10:00:00Z",
    last_activity_at: "2026-06-24T10:05:00Z",
    closed_at: null,
    collected: {
      conversation_id: "conv-abc",
      subject_kind: "self",
      subject_display_name: "Mikhail",
      service_interest: "cleaning",
      notes: "existing note",
    },
    meta: {},
    ...overrides,
  };
}

// Multi-call RPC mock for mergeCaseState:
// Call 1: rpc_get_contact_case_context_v1 (raw lookup)
// Call 2: rpc_apply_case_decision_v1      (reuse_case write)
// Call 3: rpc_get_contact_case_context_v1 (follow-up read)
function makeMergeCaseRpc(opts: {
  lookupCases?: unknown[];
  lookupError?: unknown;
  mergeError?: unknown;
  readBackCases?: unknown[];
} = {}): { rpc: RpcCaller; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  let contextCallCount = 0;
  const rpc: RpcCaller = async (fn, args) => {
    calls.push({ fn, args: args as Record<string, unknown> });
    if (fn === "rpc_get_contact_case_context_v1") {
      contextCallCount++;
      if (contextCallCount === 1) {
        if (opts.lookupError) return { data: null, error: opts.lookupError };
        const cases = opts.lookupCases ?? [makeMergeRawCase()];
        return { data: [{ open_cases: cases }], error: null };
      }
      // Follow-up read after merge
      const cases = opts.readBackCases ?? opts.lookupCases ?? [makeMergeRawCase()];
      return { data: [{ open_cases: cases }], error: null };
    }
    if (fn === "rpc_apply_case_decision_v1") {
      if (opts.mergeError) return { data: null, error: opts.mergeError };
      return { data: [{ case_id: "case-001" }], error: null };
    }
    return { data: null, error: { message: `unexpected RPC: ${fn}` } };
  };
  return { rpc, calls };
}

const BASE_MERGE_INPUT: MergeCaseStateInput = {
  clinic_id: "clinic-1",
  contact_id: "contact-1",
  conversation_id: "conv-abc",
  case_id: "case-001",
  patch: { service_interest: "implant", notes: "updated note" },
};

// --- Case type preservation ---

test("mergeCaseState: passes exact raw physical case_type in p_case_type (not re-derived)", async () => {
  const { rpc, calls } = makeMergeCaseRpc({
    lookupCases: [makeMergeRawCase({ case_type: "booking_request" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState(BASE_MERGE_INPUT);
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall, "rpc_apply_case_decision_v1 must be called");
  assert.equal(mergeCall.args.p_case_type, "booking_request");
});

test("mergeCaseState: preserves availability_request verbatim (not remapped to booking_request)", async () => {
  const { rpc, calls } = makeMergeCaseRpc({
    lookupCases: [makeMergeRawCase({ case_type: "availability_request" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState(BASE_MERGE_INPUT);
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.p_case_type, "availability_request");
});

test("mergeCaseState: preserves admin_request verbatim", async () => {
  const { rpc, calls } = makeMergeCaseRpc({
    lookupCases: [makeMergeRawCase({ case_type: "admin_request" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState(BASE_MERGE_INPUT);
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.p_case_type, "admin_request");
});

test("mergeCaseState: returns error when raw case_type is missing from existing row", async () => {
  const raw = makeMergeRawCase();
  delete (raw as Record<string, unknown>).case_type;
  const { rpc } = makeMergeCaseRpc({ lookupCases: [raw] });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState(BASE_MERGE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_type_missing_on_existing_case");
});

// --- Target lookup ---

test("mergeCaseState: returns error when target case_id is not found", async () => {
  const { rpc } = makeMergeCaseRpc({
    lookupCases: [makeMergeRawCase({ case_id: "other-case" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState(BASE_MERGE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_not_found_in_active_cases");
});

test("mergeCaseState: filters by conversation_id — does not merge case from another conversation", async () => {
  const { rpc } = makeMergeCaseRpc({
    lookupCases: [
      makeMergeRawCase({
        case_id: "case-001",
        collected: { conversation_id: "conv-other" }, // different conversation
      }),
    ],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState(BASE_MERGE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_not_found_in_active_cases");
});

// --- Collected merge ---

test("mergeCaseState: applies patch fields to p_collected", async () => {
  const { rpc, calls } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState({
    ...BASE_MERGE_INPUT,
    patch: { service_interest: "implant", notes: "new note" },
  });
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  const col = mergeCall.args.p_collected as Record<string, unknown>;
  assert.equal(col.service_interest, "implant");
  assert.equal(col.notes, "new note");
});

test("mergeCaseState: preserves existing collected keys not in patch", async () => {
  const { rpc, calls } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState({
    ...BASE_MERGE_INPUT,
    patch: { service_interest: "implant" }, // notes not in patch
  });
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  const col = mergeCall.args.p_collected as Record<string, unknown>;
  // existing note must be preserved
  assert.equal(col.notes, "existing note");
  assert.equal(col.subject_display_name, "Mikhail");
});

test("mergeCaseState: does not delete conversation_id from collected", async () => {
  const { rpc, calls } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState(BASE_MERGE_INPUT);
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  const col = mergeCall.args.p_collected as Record<string, unknown>;
  assert.equal(col.conversation_id, "conv-abc");
});

// --- Patch safety ---

test("mergeCaseState: rejects terminal status closed", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({
    ...BASE_MERGE_INPUT,
    patch: { status: "closed" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_terminal_status_rejected");
});

test("mergeCaseState: rejects terminal status cancelled", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({
    ...BASE_MERGE_INPUT,
    patch: { status: "cancelled" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_terminal_status_rejected");
});

test("mergeCaseState: rejects terminal status expired", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({
    ...BASE_MERGE_INPUT,
    patch: { status: "expired" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_terminal_status_rejected");
});

// --- RPC args ---

test("mergeCaseState: calls rpc_apply_case_decision_v1 with p_case_action = reuse_case", async () => {
  const { rpc, calls } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState(BASE_MERGE_INPUT);
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall, "rpc_apply_case_decision_v1 must be called");
  assert.equal(mergeCall.args.p_case_action, "reuse_case");
});

test("mergeCaseState: passes p_target_case_id", async () => {
  const { rpc, calls } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState(BASE_MERGE_INPUT);
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.p_target_case_id, "case-001");
});

test("mergeCaseState: propagates RPC error as RuntimeResult error code case_merge_failed", async () => {
  const { rpc } = makeMergeCaseRpc({ mergeError: { message: "merge rpc failed" } });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState(BASE_MERGE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_failed");
});

// --- Return value ---

test("mergeCaseState: returns normalized Case from follow-up read", async () => {
  const readBackCase = makeMergeRawCase({
    collected: {
      conversation_id: "conv-abc",
      subject_kind: "self",
      subject_display_name: "Mikhail",
      service_interest: "implant",
      notes: "updated note",
    },
  });
  const { rpc } = makeMergeCaseRpc({ readBackCases: [readBackCase] });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({
    ...BASE_MERGE_INPUT,
    patch: { service_interest: "implant", notes: "updated note" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.case_id, "case-001");
  assert.equal(result.data.service_interest, "implant");
  assert.equal(result.data.notes, "updated note");
});

// --- Status preservation ---

test("mergeCaseState: when patch.status omitted and raw.status=collecting, sends p_case_status=collecting", async () => {
  const { rpc, calls } = makeMergeCaseRpc({
    lookupCases: [makeMergeRawCase({ status: "collecting" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { service_interest: "implant" } });
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.p_case_status, "collecting");
});

test("mergeCaseState: when patch.status omitted and raw.status=waiting_patient, sends p_case_status=waiting_patient", async () => {
  const { rpc, calls } = makeMergeCaseRpc({
    lookupCases: [makeMergeRawCase({ status: "waiting_patient" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { service_interest: "implant" } });
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.p_case_status, "waiting_patient");
});

test("mergeCaseState: returns error when raw.status is missing", async () => {
  const raw = makeMergeRawCase();
  delete (raw as Record<string, unknown>).status;
  const { rpc } = makeMergeCaseRpc({ lookupCases: [raw] });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_status_missing_on_existing_case");
});

test("mergeCaseState: returns error when raw.status is empty string", async () => {
  const { rpc } = makeMergeCaseRpc({
    lookupCases: [makeMergeRawCase({ status: "" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_status_missing_on_existing_case");
});

// --- Patch status allowed/rejected ---

test("mergeCaseState: patch.status=collecting sends p_case_status=collecting", async () => {
  const { rpc, calls } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { status: "collecting" } });
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.p_case_status, "collecting");
});

test("mergeCaseState: patch.status=handoff sends p_case_status=handoff", async () => {
  const { rpc, calls } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { status: "handoff" } });
  const mergeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.p_case_status, "handoff");
});

test("mergeCaseState: patch.status=ready_for_action returns case_merge_status_not_supported", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { status: "ready_for_action" } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_status_not_supported");
});

test("mergeCaseState: patch.status=action_in_progress returns case_merge_status_not_supported", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { status: "action_in_progress" } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_status_not_supported");
});

test("mergeCaseState: patch.status=closed returns case_merge_terminal_status_rejected", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { status: "closed" } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_terminal_status_rejected");
});

test("mergeCaseState: patch.status=cancelled returns case_merge_terminal_status_rejected", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { status: "cancelled" } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_terminal_status_rejected");
});

test("mergeCaseState: patch.status=expired returns case_merge_terminal_status_rejected", async () => {
  const { rpc } = makeMergeCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.mergeCaseState({ ...BASE_MERGE_INPUT, patch: { status: "expired" } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_merge_terminal_status_rejected");
});

// ---------------------------------------------------------------------------
// closeCase — write path
// ---------------------------------------------------------------------------

// Multi-call RPC mock for closeCase:
// Call 1: rpc_get_contact_case_context_v1 (raw lookup)
// Call 2: rpc_apply_case_decision_v1      (reuse_case close write)
// Call 3: rpc_log_case_event              (case_closed audit event, non-fatal)
function makeCloseCaseRpc(opts: {
  lookupCases?: unknown[];
  lookupError?: unknown;
  closeError?: unknown;
  closeResponseRow?: Record<string, unknown>;
} = {}): { rpc: RpcCaller; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const rpc: RpcCaller = async (fn, args) => {
    calls.push({ fn, args: args as Record<string, unknown> });
    if (fn === "rpc_get_contact_case_context_v1") {
      if (opts.lookupError) return { data: null, error: opts.lookupError };
      const cases = opts.lookupCases ?? [makeMergeRawCase()];
      return { data: [{ open_cases: cases }], error: null };
    }
    if (fn === "rpc_apply_case_decision_v1") {
      if (opts.closeError) return { data: null, error: opts.closeError };
      return { data: [opts.closeResponseRow ?? { case_id: "case-001", closed_at: "2026-06-26T12:00:00Z" }], error: null };
    }
    if (fn === "rpc_log_case_event") {
      return { data: null, error: null };
    }
    return { data: null, error: { message: `unexpected RPC: ${fn}` } };
  };
  return { rpc, calls };
}

const BASE_CLOSE_INPUT: CloseCaseInput = {
  clinic_id: "clinic-1",
  contact_id: "contact-1",
  conversation_id: "conv-abc",
  case_id: "case-001",
  outcome: "handed_off",
  reason: "patient requested human",
};

// --- outcome='booked' guard ---

test("closeCase: rejects outcome='booked' before any RPC call", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase({ ...BASE_CLOSE_INPUT, outcome: "booked" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_close_booked_outcome_forbidden");
  assert.equal(calls.length, 0, "no RPC calls must be made when outcome=booked is rejected");
});

// --- RPC args ---

test("closeCase: passes p_case_action=reuse_case", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall, "rpc_apply_case_decision_v1 must be called");
  assert.equal(closeCall.args.p_case_action, "reuse_case");
});

test("closeCase: passes p_case_status='closed' always", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  assert.equal(closeCall.args.p_case_status, "closed", "status must always be closed, not handoff");
});

test("closeCase: passes p_target_case_id", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  assert.equal(closeCall.args.p_target_case_id, "case-001");
});

// --- Physical case_type preservation ---

test("closeCase: preserves physical case_type=booking_request without remapping", async () => {
  const { rpc, calls } = makeCloseCaseRpc({
    lookupCases: [makeMergeRawCase({ case_type: "booking_request" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  assert.equal(closeCall.args.p_case_type, "booking_request");
});

test("closeCase: preserves physical case_type=urgent without remapping", async () => {
  const { rpc, calls } = makeCloseCaseRpc({
    lookupCases: [makeMergeRawCase({ case_type: "urgent" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  assert.equal(closeCall.args.p_case_type, "urgent");
});

test("closeCase: preserves physical case_type=admin_request when closing with handoff reason", async () => {
  const { rpc, calls } = makeCloseCaseRpc({
    lookupCases: [makeMergeRawCase({ case_type: "admin_request" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase({ ...BASE_CLOSE_INPUT, reason: "patient wants human" });
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  assert.equal(closeCall.args.p_case_type, "admin_request");
  assert.equal(closeCall.args.p_case_status, "closed");
});

// --- status='closed' not 'handoff' ---

test("closeCase: passes p_case_status=closed even when reason is handoff-related", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase({ ...BASE_CLOSE_INPUT, outcome: "handed_off", reason: "escalation" });
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  assert.notEqual(closeCall.args.p_case_status, "handoff", "status must be closed, not handoff");
  assert.equal(closeCall.args.p_case_status, "closed");
});

// --- outcome and reason in collected ---

test("closeCase: stores outcome in collected", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase({ ...BASE_CLOSE_INPUT, outcome: "handed_off" });
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  const col = closeCall.args.p_collected as Record<string, unknown>;
  assert.equal(col.outcome, "handed_off");
});

test("closeCase: stores reason in collected.handoff_reason", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase({ ...BASE_CLOSE_INPUT, reason: "patient escalation" });
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  const col = closeCall.args.p_collected as Record<string, unknown>;
  assert.equal(col.handoff_reason, "patient escalation");
});

// --- conversation_id preservation ---

test("closeCase: preserves existing conversation_id in collected — never removed", async () => {
  const { rpc, calls } = makeCloseCaseRpc({
    lookupCases: [makeMergeRawCase({
      collected: {
        conversation_id: "conv-abc",
        subject_kind: "self",
        subject_display_name: "Mikhail",
        service_interest: "cleaning",
        notes: "existing note",
      },
    })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const closeCall = calls.find((c) => c.fn === "rpc_apply_case_decision_v1");
  assert.ok(closeCall);
  const col = closeCall.args.p_collected as Record<string, unknown>;
  assert.equal(col.conversation_id, "conv-abc", "conversation_id must be preserved");
});

// --- return value ---

test("closeCase: returns normalized Case with status=closed", async () => {
  const { rpc } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase(BASE_CLOSE_INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.status, "closed");
  assert.equal(result.data.case_id, "case-001");
});

test("closeCase: return value reflects outcome passed by caller", async () => {
  const { rpc } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase({ ...BASE_CLOSE_INPUT, outcome: "abandoned" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.outcome, "abandoned");
});

test("closeCase: return value reflects reason in handoff_reason", async () => {
  const { rpc } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase({ ...BASE_CLOSE_INPUT, reason: "escalation reason" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.handoff_reason, "escalation reason");
});

// --- not found / already terminal ---

test("closeCase: returns error when case not found in active cases", async () => {
  const { rpc } = makeCloseCaseRpc({
    lookupCases: [makeMergeRawCase({ case_id: "other-case" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase(BASE_CLOSE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_not_found_in_active_cases");
});

test("closeCase: returns case_close_already_terminal when status=closed", async () => {
  const { rpc } = makeCloseCaseRpc({
    lookupCases: [makeMergeRawCase({ status: "closed" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase(BASE_CLOSE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_close_already_terminal");
});

test("closeCase: returns case_close_already_terminal when status=cancelled", async () => {
  const { rpc } = makeCloseCaseRpc({
    lookupCases: [makeMergeRawCase({ status: "cancelled" })],
  });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase(BASE_CLOSE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_close_already_terminal");
});

// --- RPC error propagation ---

test("closeCase: propagates RPC error as case_close_failed", async () => {
  const { rpc } = makeCloseCaseRpc({ closeError: { message: "rpc close error" } });
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase(BASE_CLOSE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "case_close_failed");
});

// --- Audit event ---

test("closeCase: appends case_closed audit event via rpc_log_case_event", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const eventCall = calls.find((c) => c.fn === "rpc_log_case_event");
  assert.ok(eventCall, "rpc_log_case_event must be called for audit trail");
  assert.equal(eventCall.args.p_event_type, "case_closed");
  assert.equal(eventCall.args.p_case_id, "case-001");
});

test("closeCase: audit event failure does not fail closeCase (non-fatal)", async () => {
  const calls: RpcCall[] = [];
  const rpc: RpcCaller = async (fn, args) => {
    calls.push({ fn, args: args as Record<string, unknown> });
    if (fn === "rpc_get_contact_case_context_v1") return { data: [{ open_cases: [makeMergeRawCase()] }], error: null };
    if (fn === "rpc_apply_case_decision_v1") return { data: [{ case_id: "case-001" }], error: null };
    if (fn === "rpc_log_case_event") return { data: null, error: { message: "audit event failed" } };
    return { data: null, error: { message: `unexpected RPC: ${fn}` } };
  };
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase(BASE_CLOSE_INPUT);
  assert.equal(result.ok, true, "closeCase must succeed even if audit event write fails");
});

// --- Side-effect safety ---

test("closeCase: does not call any booking, notification, or n8n RPC", async () => {
  const { rpc, calls } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  await repo.closeCase(BASE_CLOSE_INPUT);
  const forbidden = calls.filter((c) =>
    c.fn.includes("booking") ||
    c.fn.includes("appointment") ||
    c.fn.includes("slot_hold") ||
    c.fn.includes("notification") ||
    c.fn.includes("n8n") ||
    c.fn.includes("telegram")
  );
  assert.equal(forbidden.length, 0, `closeCase must not call booking/notification RPCs: ${JSON.stringify(forbidden.map((c) => c.fn))}`);
});

test("closeCase: return Case does not include outcome=booked", async () => {
  const { rpc } = makeCloseCaseRpc({});
  const repo = createSupabaseCaseRepository({ rpc });
  const result = await repo.closeCase({ ...BASE_CLOSE_INPUT, outcome: "handed_off" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.data.outcome, "booked", "outcome=booked must never appear on a closed case via closeCase");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireBookingSlotLock,
  _resetSlotLocks,
  _activeLockCount,
} from "../src/integrations/cliniccard/bookingSlotMutex.ts";
import { createBookingApplyExecutor } from "../src/integrations/cliniccard/bookingApplyExecutor.ts";
import type { ClinicCardAdapter } from "../src/integrations/cliniccard/clinicCardAdapter.ts";
import type { ToolExecutionContext } from "../src/runtime/toolExecutor.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

const LIVE_ENV: Record<string, string> = {
  CLINICCARD_API_BASE_URL: "https://cliniccard.example",
  CLINICCARD_API_TOKEN: "tok_test",
  CLINICCARD_BOOKING_MODE: "live",
  CLINICCARD_DEFAULT_DOCTOR_ID: "1",
  CLINICCARD_DEFAULT_CABINET_ID: "2",
  CLINICCARD_TIMEZONE: "Europe/Prague",
  CLINICCARD_LIVE_CLINIC_ALLOWLIST: "clinic_1",
};

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
    first_name: "Ivan",
    last_name: "Petrov",
    service_interest: "Чистка",
    requested_date: "2026-07-20",
    requested_time: "10:00",
    phone_number: "+420777111222",
    phone_source: "telegram_contact_button",
    ...overrides,
  };
}

// Stateful adapter: visits list is shared across all calls to the same instance.
// delayListVisitsMs > 0 forces a yield between listVisits and createVisit so that
// truly concurrent calls both reach listVisits before either calls createVisit.
function makeStatefulAdapter(delayListVisitsMs = 5): ClinicCardAdapter & { createVisitCalls: number } {
  const visits: Array<{
    id: number;
    patient_id: number;
    doctor_id: number;
    cabinet_id: number;
    date: string;
    time_start: string;
    time_end: string;
    status: string;
    note: string | null;
  }> = [];
  let nextId = 100;

  const adapter = {
    createVisitCalls: 0 as number,
    async listVisits() {
      if (delayListVisitsMs > 0) {
        await new Promise<void>((r) => setTimeout(r, delayListVisitsMs));
      }
      return { ok: true as const, data: [...visits] };
    },
    async findPatientByPhone() {
      return { ok: true as const, data: [{ id: 42, name: "Ivan Petrov", phone: "+420777111222" }] };
    },
    async createPatient(input: { name: string; phone?: string }) {
      return { ok: true as const, data: { id: 42, name: input.name, phone: input.phone ?? null } };
    },
    async createVisit(input: {
      patient_id: number;
      doctor_id: number;
      cabinet_id: number;
      date: string;
      time_start: string;
      time_end: string;
      status: string;
      note?: string;
    }) {
      adapter.createVisitCalls++;
      const id = nextId++;
      visits.push({
        id,
        patient_id: input.patient_id,
        doctor_id: input.doctor_id,
        cabinet_id: input.cabinet_id,
        date: input.date,
        time_start: input.time_start,
        time_end: input.time_end,
        status: input.status,
        note: input.note ?? null,
      });
      return {
        ok: true as const,
        data: {
          id,
          patient_id: input.patient_id,
          doctor_id: input.doctor_id,
          cabinet_id: input.cabinet_id,
          date: input.date,
          time_start: input.time_start,
          time_end: input.time_end,
          status: input.status,
          note: input.note ?? null,
        },
      };
    },
    async listPayments() {
      return { ok: true as const, data: [] };
    },
  };
  return adapter;
}

// ── mutex primitive: acquireBookingSlotLock ───────────────────────────────────

test("mutex: first acquire resolves immediately", async () => {
  _resetSlotLocks();
  const rel = await acquireBookingSlotLock("c1", "2026-07-20", 1, 2);
  // Two sub-locks acquired (cabinet + doctor)
  assert.equal(_activeLockCount(), 2);
  rel();
  assert.equal(_activeLockCount(), 0);
});

test("mutex: same doctor+cabinet blocks second caller until first releases", async () => {
  _resetSlotLocks();
  const order: number[] = [];

  const rel1 = await acquireBookingSlotLock("c1", "2026-07-20", 1, 2);
  order.push(1);

  const p2 = acquireBookingSlotLock("c1", "2026-07-20", 1, 2).then((rel2) => {
    order.push(2);
    rel2();
  });

  assert.deepEqual(order, [1]); // p2 still waiting
  rel1();
  await p2;
  assert.deepEqual(order, [1, 2]);
  assert.equal(_activeLockCount(), 0);
});

test("mutex: different doctor+cabinet do not block each other", async () => {
  _resetSlotLocks();
  const rel1 = await acquireBookingSlotLock("c1", "2026-07-20", 1, 2);
  const rel2 = await acquireBookingSlotLock("c1", "2026-07-20", 3, 4); // diff doctor AND cabinet
  assert.equal(_activeLockCount(), 4); // 2 sub-locks each
  rel1();
  rel2();
  assert.equal(_activeLockCount(), 0);
});

test("mutex: same doctor but different cabinet blocks (doctor dimension)", async () => {
  _resetSlotLocks();
  const order: number[] = [];

  const rel1 = await acquireBookingSlotLock("c1", "2026-07-20", 1, 2);  // doctor=1, cabinet=2
  order.push(1);

  const p2 = acquireBookingSlotLock("c1", "2026-07-20", 1, 99).then((rel2) => { // doctor=1, cabinet=99
    order.push(2);
    rel2();
  });

  assert.deepEqual(order, [1]); // blocked on shared doctor:1 key
  rel1();
  await p2;
  assert.deepEqual(order, [1, 2]);
  assert.equal(_activeLockCount(), 0);
});

test("mutex: same cabinet but different doctor blocks (cabinet dimension)", async () => {
  _resetSlotLocks();
  const order: number[] = [];

  const rel1 = await acquireBookingSlotLock("c1", "2026-07-20", 1, 2);  // doctor=1, cabinet=2
  order.push(1);

  const p2 = acquireBookingSlotLock("c1", "2026-07-20", 99, 2).then((rel2) => { // doctor=99, cabinet=2
    order.push(2);
    rel2();
  });

  assert.deepEqual(order, [1]); // blocked on shared cabinet:2 key
  rel1();
  await p2;
  assert.deepEqual(order, [1, 2]);
  assert.equal(_activeLockCount(), 0);
});

// ── executor: disabled mode blocks before lock ────────────────────────────────

test("disabled mode: returns before lock, no lock held after return", async () => {
  _resetSlotLocks();
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "disabled" },
    adapterFactory: () => makeStatefulAdapter(),
  });
  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "booking_write_disabled");
  assert.equal(result.data.created_visit, false);
  assert.equal(_activeLockCount(), 0);
});

// ── executor: concurrent overlapping times same doctor+cabinet ────────────────

test("concurrent 10:00 and 10:15 same doctor+cabinet: only one createVisit", async () => {
  _resetSlotLocks();
  const adapter = makeStatefulAdapter();
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });

  const [r1, r2] = await Promise.all([
    executor(makeContext({ requested_time: "10:00" })),
    executor(makeContext({ requested_time: "10:15" })),
  ]);

  assert.equal(adapter.createVisitCalls, 1, "only one createVisit must be called");
  const statuses = [r1.data.booking_status, r2.data.booking_status].sort();
  assert.deepEqual(statuses, ["slot_conflict", "visit_created"]);
});

test("concurrent 10:00 and 10:15 same slot: loser gets slot_conflict with correct fields", async () => {
  _resetSlotLocks();
  const adapter = makeStatefulAdapter();
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });

  const [r1, r2] = await Promise.all([
    executor(makeContext({ requested_time: "10:00" })),
    executor(makeContext({ requested_time: "10:15" })),
  ]);

  const loser = [r1, r2].find((r) => r.data.booking_status === "slot_conflict");
  assert.ok(loser, "one result must be slot_conflict");
  assert.equal(loser!.data.created_visit, false);
  assert.equal(loser!.data.may_claim_booked, false);
  assert.equal(loser!.data.cliniccard_visit_id, null);
});

// ── executor: same doctor but different cabinet (test 2) ──────────────────────

test("concurrent same doctor diff cabinet overlapping: only one createVisit", async () => {
  _resetSlotLocks();
  // Both executors share the same stateful adapter so listVisits reflects reality.
  const sharedAdapter = makeStatefulAdapter();

  const exec1 = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_CABINET_ID: "2" },
    adapterFactory: () => sharedAdapter,
  });
  const exec2 = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_CABINET_ID: "99" },
    adapterFactory: () => sharedAdapter,
  });

  // doctor=1 is the same for both; 10:00-10:30 overlaps with 10:15-10:45.
  const [r1, r2] = await Promise.all([
    exec1(makeContext({ requested_time: "10:00" })),
    exec2(makeContext({ requested_time: "10:15" })),
  ]);

  assert.equal(sharedAdapter.createVisitCalls, 1, "same doctor serializes; only one visit");
  const statuses = [r1.data.booking_status, r2.data.booking_status].sort();
  assert.deepEqual(statuses, ["slot_conflict", "visit_created"]);
});

// ── executor: same cabinet but different doctor (test 3) ──────────────────────

test("concurrent same cabinet diff doctor overlapping: only one createVisit", async () => {
  _resetSlotLocks();
  const sharedAdapter = makeStatefulAdapter();

  const exec1 = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "1" },
    adapterFactory: () => sharedAdapter,
  });
  const exec2 = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "99" },
    adapterFactory: () => sharedAdapter,
  });

  // cabinet=2 is the same for both; 10:00-10:30 overlaps with 10:15-10:45.
  const [r1, r2] = await Promise.all([
    exec1(makeContext({ requested_time: "10:00" })),
    exec2(makeContext({ requested_time: "10:15" })),
  ]);

  assert.equal(sharedAdapter.createVisitCalls, 1, "same cabinet serializes; only one visit");
  const statuses = [r1.data.booking_status, r2.data.booking_status].sort();
  assert.deepEqual(statuses, ["slot_conflict", "visit_created"]);
});

// ── executor: non-overlapping same resource (test 4) ─────────────────────────

test("non-overlapping same doctor+cabinet: 10:00 and 11:00 both eventually visit_created", async () => {
  _resetSlotLocks();
  const adapter = makeStatefulAdapter();
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });

  const [r1, r2] = await Promise.all([
    executor(makeContext({ requested_time: "10:00" })),
    executor(makeContext({ requested_time: "11:00" })),
  ]);

  // Serialized internally but no interval overlap → both succeed.
  assert.equal(r1.data.booking_status, "visit_created");
  assert.equal(r2.data.booking_status, "visit_created");
  assert.equal(adapter.createVisitCalls, 2);
});

// ── executor: exact same slot (test 5) ───────────────────────────────────────

test("exact same slot concurrent: only one createVisit, loser gets slot_conflict", async () => {
  _resetSlotLocks();
  const adapter = makeStatefulAdapter();
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });
  const ctx = makeContext();

  const [r1, r2] = await Promise.all([executor(ctx), executor(ctx)]);

  assert.equal(adapter.createVisitCalls, 1);
  const statuses = [r1.data.booking_status, r2.data.booking_status].sort();
  assert.deepEqual(statuses, ["slot_conflict", "visit_created"]);
});

// ── executor: lock released on createVisit throw (test 7) ────────────────────

test("lock released when createVisit throws", async () => {
  _resetSlotLocks();
  const throwingAdapter: ClinicCardAdapter = {
    async listVisits() { return { ok: true, data: [] }; },
    async findPatientByPhone() { return { ok: true, data: [{ id: 1, name: "x", phone: "y" }] }; },
    async createPatient(i) { return { ok: true, data: { id: 1, name: i.name } }; },
    async createVisit() { throw new Error("ClinicCard network failure"); },
    async listPayments() { return { ok: true, data: [] }; },
  };
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => throwingAdapter,
  });

  await assert.rejects(executor(makeContext()), /ClinicCard network failure/);
  assert.equal(_activeLockCount(), 0);
});

// ── executor: existing slot_conflict behavior unchanged (test 6) ──────────────

test("existing slot_conflict unchanged when ClinicCard already has conflicting visit", async () => {
  _resetSlotLocks();
  const preexistingVisit = {
    id: 5,
    patient_id: 1,
    doctor_id: 1,
    cabinet_id: 2,
    date: "2026-07-20",
    time_start: "10:00",
    time_end: "10:30",
    status: "PLANNED",
    note: null,
  };
  let createVisitCalled = false;
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => ({
      async listVisits() { return { ok: true, data: [preexistingVisit] }; },
      async findPatientByPhone() { return { ok: true, data: [] }; },
      async createPatient(i) { return { ok: true, data: { id: 1, name: i.name } }; },
      async createVisit() {
        createVisitCalled = true;
        return { ok: false, error: { code: "e", message: "should not reach here" } };
      },
      async listPayments() { return { ok: true, data: [] }; },
    }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "slot_conflict");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.equal(createVisitCalled, false);
  assert.equal(_activeLockCount(), 0);
});

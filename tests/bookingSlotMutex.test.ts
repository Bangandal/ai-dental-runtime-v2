import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireSlotLock,
  buildSlotLockKey,
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

// Stateful adapter: visits are shared across calls to simulate real ClinicCard state.
function makeStatefulAdapter(delayListVisitsMs = 0): ClinicCardAdapter & { createVisitCalls: number } {
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

  return {
    createVisitCalls: 0,
    async listVisits() {
      if (delayListVisitsMs > 0) {
        await new Promise<void>((r) => setTimeout(r, delayListVisitsMs));
      }
      return { ok: true, data: [...visits] };
    },
    async findPatientByPhone() {
      return { ok: true, data: [{ id: 42, name: "Ivan Petrov", phone: "+420777111222" }] };
    },
    async createPatient(input) {
      return { ok: true, data: { id: 42, name: input.name, phone: input.phone ?? null } };
    },
    async createVisit(input) {
      (this as { createVisitCalls: number }).createVisitCalls++;
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
        ok: true,
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
      return { ok: true, data: [] };
    },
  };
}

// ── buildSlotLockKey ─────────────────────────────────────────────────────────

test("buildSlotLockKey includes all five dimensions", () => {
  const key = buildSlotLockKey({
    clinic_id: "c1",
    requested_date: "2026-07-20",
    requested_time: "10:00",
    doctor_id: 1,
    cabinet_id: 2,
  });
  assert.ok(key.includes("c1"), "clinic_id");
  assert.ok(key.includes("2026-07-20"), "date");
  assert.ok(key.includes("10:00"), "time");
  assert.ok(key.includes("1"), "doctor_id");
  assert.ok(key.includes("2"), "cabinet_id");
});

test("buildSlotLockKey differs by time", () => {
  const k1 = buildSlotLockKey({ clinic_id: "c1", requested_date: "2026-07-20", requested_time: "10:00", doctor_id: 1, cabinet_id: 2 });
  const k2 = buildSlotLockKey({ clinic_id: "c1", requested_date: "2026-07-20", requested_time: "11:00", doctor_id: 1, cabinet_id: 2 });
  assert.notEqual(k1, k2);
});

test("buildSlotLockKey differs by doctor_id", () => {
  const k1 = buildSlotLockKey({ clinic_id: "c1", requested_date: "2026-07-20", requested_time: "10:00", doctor_id: 1, cabinet_id: 2 });
  const k2 = buildSlotLockKey({ clinic_id: "c1", requested_date: "2026-07-20", requested_time: "10:00", doctor_id: 9, cabinet_id: 2 });
  assert.notEqual(k1, k2);
});

test("buildSlotLockKey differs by cabinet_id", () => {
  const k1 = buildSlotLockKey({ clinic_id: "c1", requested_date: "2026-07-20", requested_time: "10:00", doctor_id: 1, cabinet_id: 2 });
  const k2 = buildSlotLockKey({ clinic_id: "c1", requested_date: "2026-07-20", requested_time: "10:00", doctor_id: 1, cabinet_id: 9 });
  assert.notEqual(k1, k2);
});

// ── acquireSlotLock / mutex primitives ───────────────────────────────────────

test("mutex: first acquire resolves immediately", async () => {
  _resetSlotLocks();
  const release = await acquireSlotLock("key-a");
  assert.equal(_activeLockCount(), 1);
  release();
  assert.equal(_activeLockCount(), 0);
});

test("mutex: lock is released on explicit call", async () => {
  _resetSlotLocks();
  const rel = await acquireSlotLock("key-b");
  rel();
  assert.equal(_activeLockCount(), 0);
});

test("mutex: second acquire on same key waits until first releases", async () => {
  _resetSlotLocks();
  const order: number[] = [];
  const rel1 = await acquireSlotLock("key-c");
  order.push(1);

  const p2 = acquireSlotLock("key-c").then((rel2) => {
    order.push(2);
    rel2();
  });

  // p2 should not have run yet — we hold the lock
  assert.deepEqual(order, [1]);

  rel1();
  await p2;
  assert.deepEqual(order, [1, 2]);
  assert.equal(_activeLockCount(), 0);
});

test("mutex: different keys do not block each other", async () => {
  _resetSlotLocks();
  const rel1 = await acquireSlotLock("key-x");
  const rel2 = await acquireSlotLock("key-y"); // must not wait for key-x
  assert.equal(_activeLockCount(), 2);
  rel1();
  rel2();
  assert.equal(_activeLockCount(), 0);
});

test("mutex: three concurrent waiters on same key are serialized FIFO", async () => {
  _resetSlotLocks();
  const order: number[] = [];
  const rel1 = await acquireSlotLock("key-q");
  order.push(1);

  const p2 = acquireSlotLock("key-q").then((r) => { order.push(2); r(); });
  const p3 = acquireSlotLock("key-q").then((r) => { order.push(3); r(); });

  rel1();
  await Promise.all([p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(_activeLockCount(), 0);
});

// ── executor: disabled mode blocks before lock ───────────────────────────────

test("booking.apply disabled: returns before acquiring lock", async () => {
  _resetSlotLocks();
  const executor = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_BOOKING_MODE: "disabled" },
    adapterFactory: () => makeStatefulAdapter(),
  });
  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "booking_write_disabled");
  assert.equal(result.data.created_visit, false);
  // Lock must NOT be held after disabled early-return
  assert.equal(_activeLockCount(), 0);
});

// ── executor: concurrent same-slot serialization ─────────────────────────────

test("two concurrent booking.apply calls for same slot: only one createVisit", async () => {
  _resetSlotLocks();
  // delayListVisitsMs=5 ensures both calls enter the executor before the lock
  // is released, producing true concurrency at the await point.
  const adapter = makeStatefulAdapter(5);
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });
  const ctx = makeContext();

  const [r1, r2] = await Promise.all([executor(ctx), executor(ctx)]);

  // Exactly one visit should have been created
  assert.equal(adapter.createVisitCalls, 1, "createVisit must be called exactly once");

  // One succeeds, one sees conflict
  const statuses = [r1.data.booking_status, r2.data.booking_status].sort();
  assert.deepEqual(statuses, ["slot_conflict", "visit_created"]);
});

test("same slot: second call gets slot_conflict, not visit_created", async () => {
  _resetSlotLocks();
  const adapter = makeStatefulAdapter(5);
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });
  const ctx = makeContext();

  const [r1, r2] = await Promise.all([executor(ctx), executor(ctx)]);
  const results = [r1, r2];
  const winner = results.find((r) => r.data.booking_status === "visit_created");
  const loser = results.find((r) => r.data.booking_status === "slot_conflict");

  assert.ok(winner, "one call must succeed");
  assert.ok(loser, "one call must get slot_conflict");
  assert.equal(loser?.data.created_visit, false);
  assert.equal(loser?.data.may_claim_booked, false);
});

// ── executor: different slots proceed independently ──────────────────────────

test("different requested_time: both calls proceed independently", async () => {
  _resetSlotLocks();
  const adapter = makeStatefulAdapter(0);
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });

  const [r1, r2] = await Promise.all([
    executor(makeContext({ requested_time: "09:00" })),
    executor(makeContext({ requested_time: "11:00" })),
  ]);

  assert.equal(r1.data.booking_status, "visit_created");
  assert.equal(r2.data.booking_status, "visit_created");
  assert.equal(adapter.createVisitCalls, 2, "both slots create a visit independently");
});

test("different doctor_id does not block same time slot", async () => {
  _resetSlotLocks();
  // Two separate adapters/executors simulating different doctor configs
  const adapter1 = makeStatefulAdapter(0);
  const adapter2 = makeStatefulAdapter(0);

  const exec1 = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "1", CLINICCARD_DEFAULT_CABINET_ID: "10" },
    adapterFactory: () => adapter1,
  });
  const exec2 = createBookingApplyExecutor({
    env: { ...LIVE_ENV, CLINICCARD_DEFAULT_DOCTOR_ID: "2", CLINICCARD_DEFAULT_CABINET_ID: "20" },
    adapterFactory: () => adapter2,
  });

  const [r1, r2] = await Promise.all([
    exec1(makeContext({ requested_time: "10:00" })),
    exec2(makeContext({ requested_time: "10:00" })),
  ]);

  assert.equal(r1.data.booking_status, "visit_created");
  assert.equal(r2.data.booking_status, "visit_created");
});

// ── executor: lock released on error ─────────────────────────────────────────

test("lock is released when createVisit throws", async () => {
  _resetSlotLocks();
  const adapter: ClinicCardAdapter = {
    async listVisits() { return { ok: true, data: [] }; },
    async findPatientByPhone() { return { ok: true, data: [{ id: 1, name: "x", phone: "y" }] }; },
    async createPatient(i) { return { ok: true, data: { id: 1, name: i.name } }; },
    async createVisit() { throw new Error("ClinicCard network failure"); },
    async listPayments() { return { ok: true, data: [] }; },
  };

  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => adapter,
  });

  await assert.rejects(executor(makeContext()), /ClinicCard network failure/);

  // Lock must be released even after a thrown error
  assert.equal(_activeLockCount(), 0);
});

// ── executor: existing conflict behavior unchanged ────────────────────────────

test("existing slot_conflict behavior unchanged when ClinicCard already has a visit", async () => {
  _resetSlotLocks();
  const conflictingVisit = {
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
  const executor = createBookingApplyExecutor({
    env: LIVE_ENV,
    adapterFactory: () => ({
      async listVisits() { return { ok: true, data: [conflictingVisit] }; },
      async findPatientByPhone() { return { ok: true, data: [] }; },
      async createPatient(i) { return { ok: true, data: { id: 1, name: i.name } }; },
      async createVisit() { return { ok: false, error: { code: "e", message: "should not be called" } }; },
      async listPayments() { return { ok: true, data: [] }; },
    }),
  });

  const result = await executor(makeContext());
  assert.equal(result.data.booking_status, "slot_conflict");
  assert.equal(result.data.created_visit, false);
  assert.equal(result.data.may_claim_booked, false);
  assert.equal(_activeLockCount(), 0);
});

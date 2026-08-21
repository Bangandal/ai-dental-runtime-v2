import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryBookingProcessStateRepository,
  type BookingProcessStateRepository,
} from "../src/runtime/bookingProcessState.ts";
import {
  createBookingReconciliationCoordinator,
  type BookingReconciliationLock,
} from "../src/runtime/bookingReconciliationCoordinator.ts";

const KEY = { clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_1" };
const LOCK: BookingReconciliationLock = {
  status: "pending",
  armed_at: "2026-08-21T16:40:00.000Z",
  reason: "write_in_flight_or_outcome_unknown",
  date: "2099-08-21",
  time_start: "10:00",
  time_end: "10:30",
  doctor_id: 10,
  cabinet_id: 20,
  service_interest: "consultation",
  patient_id: 33,
};

test("PF-012 coordinator: hidden lock survives ordinary booking state saves but is never exposed on load", async () => {
  const base = createInMemoryBookingProcessStateRepository();
  const coordinator = createBookingReconciliationCoordinator(base);

  const armed = await coordinator.guard.arm(KEY, LOCK);
  assert.deepEqual(armed, { ok: true });

  const visibleBefore = await coordinator.stateRepository.loadState(KEY);
  assert.ok(visibleBefore);
  assert.equal(JSON.stringify(visibleBefore).includes("__booking_reconciliation_v1"), false);

  await coordinator.stateRepository.saveState(KEY, {
    service_reason: "consultation",
    proof: {
      service_known: true,
      name_known: false,
      slot_known: false,
      trusted_phone_known: false,
      ready_for_booking_apply: false,
    },
  });

  const pendingAfterRuntimeSave = await coordinator.guard.getPending(KEY);
  assert.equal(pendingAfterRuntimeSave.ok, true);
  if (pendingAfterRuntimeSave.ok) {
    assert.deepEqual(pendingAfterRuntimeSave.lock, LOCK);
  }

  const cleared = await coordinator.guard.clear(KEY);
  assert.deepEqual(cleared, { ok: true });
  const pendingAfterClear = await coordinator.guard.getPending(KEY);
  assert.deepEqual(pendingAfterClear, { ok: true, lock: null });
});

test("PF-012 coordinator: write-ahead arm fails if repository acknowledges save but read-back cannot prove durability", async () => {
  const lyingRepository: BookingProcessStateRepository = {
    async loadState(_key, onDebug) {
      onDebug?.({ loaded: false, reason: "null_or_missing" });
      return null;
    },
    async saveState(_key, _state, onDebug) {
      // Simulates a transport/provider bug where the call looks successful locally
      // but the durable state is not present on the following read.
      onDebug?.({ saved: true });
    },
  };

  const coordinator = createBookingReconciliationCoordinator(lyingRepository);
  const armed = await coordinator.guard.arm(KEY, LOCK);

  assert.equal(armed.ok, false);
  if (!armed.ok) {
    assert.match(armed.reason, /not durably persisted/i);
  }
});

test("PF-012 coordinator: malformed persisted safety state fails closed", async () => {
  const malformedRepository: BookingProcessStateRepository = {
    async loadState(_key, onDebug) {
      onDebug?.({ loaded: true });
      return {
        proof: {
          service_known: false,
          name_known: false,
          slot_known: false,
          trusted_phone_known: false,
          ready_for_booking_apply: false,
        },
        __booking_reconciliation_v1: { status: "maybe" },
      } as never;
    },
    async saveState() {},
  };

  const coordinator = createBookingReconciliationCoordinator(malformedRepository);
  const pending = await coordinator.guard.getPending(KEY);
  assert.equal(pending.ok, false);
  if (!pending.ok) {
    assert.match(pending.reason, /malformed/i);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import type { BookingProcessStateRepository } from "../src/runtime/bookingProcessState.ts";
import { createInMemoryBookingProcessStateRepository } from "../src/runtime/bookingProcessState.ts";
import {
  createBookingReconciliationCoordinator,
  type BookingReconciliationLock,
} from "../src/runtime/bookingReconciliationCoordinator.ts";

const LOCK: BookingReconciliationLock = {
  status: "pending",
  armed_at: "2026-08-21T16:45:00.000Z",
  reason: "write_in_flight_or_outcome_unknown",
  date: "2099-08-21",
  time_start: "10:00",
  time_end: "10:30",
  doctor_id: 10,
  cabinet_id: 20,
};

test("PF-012 guard: runtime load RPC error is never cached as authoritative no-lock", async () => {
  let loadCount = 0;
  const failingRepository: BookingProcessStateRepository = {
    async loadState(_key, onDebug) {
      loadCount += 1;
      onDebug?.({ loaded: false, reason: "rpc_error", error: "database unavailable" });
      return null;
    },
    async saveState() {
      throw new Error("save must not be attempted after failed load");
    },
  };

  const coordinator = createBookingReconciliationCoordinator(failingRepository);

  // Runtime turn starts and observes the repository outage.
  const visible = await coordinator.stateRepository.loadState({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
  });
  assert.equal(visible, null);

  // Booking boundary must retry the durable read and fail closed, not trust a cached null.
  const pending = await coordinator.guard.getPending({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_1",
  });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.match(pending.reason, /database unavailable/i);
  assert.equal(loadCount, 2);
});

test("PF-012 guard: pending write is contact-scoped across case ids", async () => {
  const coordinator = createBookingReconciliationCoordinator(createInMemoryBookingProcessStateRepository());

  const armed = await coordinator.guard.arm(
    { clinic_id: "clinic_1", contact_id: "contact_1", case_id: "case_a" },
    LOCK,
  );
  assert.deepEqual(armed, { ok: true });

  const pendingFromAnotherCase = await coordinator.guard.getPending({
    clinic_id: "clinic_1",
    contact_id: "contact_1",
    case_id: "case_b",
  });
  assert.equal(pendingFromAnotherCase.ok, true);
  if (pendingFromAnotherCase.ok) {
    assert.deepEqual(pendingFromAnotherCase.lock, LOCK);
  }
});

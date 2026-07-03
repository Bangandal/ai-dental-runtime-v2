// In-process mutex that serializes concurrent booking.apply calls targeting the
// same clinic/date/time/doctor/cabinet. Prevents duplicate ClinicCard visits
// created by two simultaneous requests that both pass the conflict check.
//
// Lock key: clinic_id:date:time:doctor_id:cabinet_id
// Different slot combinations do not block each other.

export interface SlotLockKey {
  clinic_id: string;
  requested_date: string;
  requested_time: string;
  doctor_id: number;
  cabinet_id: number;
}

export function buildSlotLockKey(key: SlotLockKey): string {
  return `${key.clinic_id}:${key.requested_date}:${key.requested_time}:${key.doctor_id}:${key.cabinet_id}`;
}

// Module-level registry: key → queue of pending waiters.
// A key present in the map means the lock is currently held.
// An empty queue means held with no waiters; a non-empty queue means held with waiters.
const _locks = new Map<string, Array<() => void>>();

// Acquire an exclusive lock for the given key string.
// Returns a release function that MUST be called in a finally block.
export function acquireSlotLock(key: string): Promise<() => void> {
  return new Promise<() => void>((resolve) => {
    const waiters = _locks.get(key);
    if (waiters === undefined) {
      // Lock is free — take it immediately.
      _locks.set(key, []);
      resolve(() => _release(key));
    } else {
      // Lock is held — enqueue.
      waiters.push(() => resolve(() => _release(key)));
    }
  });
}

function _release(key: string): void {
  const waiters = _locks.get(key);
  if (!waiters || waiters.length === 0) {
    // No waiters — free the lock entirely.
    _locks.delete(key);
  } else {
    // Hand the lock to the next waiter.
    const next = waiters.shift()!;
    next();
  }
}

// Visible for testing only.
export function _resetSlotLocks(): void {
  _locks.clear();
}

export function _activeLockCount(): number {
  return _locks.size;
}

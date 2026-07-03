// In-process mutex that serializes concurrent booking.apply calls that could
// create conflicting ClinicCard visits.
//
// The ClinicCard conflict rule is:
//   (same doctor_id OR same cabinet_id) AND overlapping time interval
//
// To prevent races for both dimensions we acquire TWO locks per call:
//   1. clinic:date:cabinet:<cabinet_id>
//   2. clinic:date:doctor:<doctor_id>
// Always in that order (cabinet first, then doctor) to prevent deadlock.
//
// Consequences:
//   - Same doctor + same cabinet  → serialized (both keys match)
//   - Same doctor + diff cabinet  → serialized by doctor key
//   - Diff doctor + same cabinet  → serialized by cabinet key
//   - Diff doctor + diff cabinet  → no conflict possible; proceed independently

// Module-level registry: key → queue of pending waiters.
// Key present in map means lock is held; empty queue = held with no waiters.
const _locks = new Map<string, Array<() => void>>();

function _acquireSingleLock(key: string): Promise<() => void> {
  return new Promise<() => void>((resolve) => {
    const waiters = _locks.get(key);
    if (waiters === undefined) {
      _locks.set(key, []);
      resolve(() => _releaseSingleLock(key));
    } else {
      waiters.push(() => resolve(() => _releaseSingleLock(key)));
    }
  });
}

function _releaseSingleLock(key: string): void {
  const waiters = _locks.get(key);
  if (!waiters || waiters.length === 0) {
    _locks.delete(key);
  } else {
    const next = waiters.shift()!;
    next();
  }
}

// Acquire the booking slot lock for the given dimensions.
// Returns a single release function — MUST be called in a finally block.
export async function acquireBookingSlotLock(
  clinicId: string,
  date: string,
  doctorId: number,
  cabinetId: number,
): Promise<() => void> {
  // Consistent acquisition order: cabinet key first, then doctor key.
  const cabinetKey = `${clinicId}:${date}:cabinet:${cabinetId}`;
  const doctorKey = `${clinicId}:${date}:doctor:${doctorId}`;

  const relCabinet = await _acquireSingleLock(cabinetKey);
  const relDoctor = await _acquireSingleLock(doctorKey);

  return () => {
    relDoctor();
    relCabinet();
  };
}

// Visible for testing only.
export function _resetSlotLocks(): void {
  _locks.clear();
}

export function _activeLockCount(): number {
  return _locks.size;
}

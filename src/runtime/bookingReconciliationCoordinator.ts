import type { BookingProcessState, BookingProcessStateRepository } from "./bookingProcessState.ts";

const RECONCILIATION_FIELD = "__booking_reconciliation_v1";

export interface BookingReconciliationKey {
  clinic_id: string;
  contact_id?: string | null;
  case_id?: string | null;
}

export interface BookingReconciliationLock {
  status: "pending";
  armed_at: string;
  reason: "write_in_flight_or_outcome_unknown";
  date: string;
  time_start: string;
  time_end: string;
  doctor_id: number;
  cabinet_id: number;
  service_interest?: string | null;
  patient_id?: number;
}

export type BookingReconciliationRead =
  | { ok: true; lock: BookingReconciliationLock | null }
  | { ok: false; reason: string };

export type BookingReconciliationMutation =
  | { ok: true }
  | { ok: false; reason: string };

export interface BookingReconciliationGuard {
  getPending(key: BookingReconciliationKey): Promise<BookingReconciliationRead>;
  arm(key: BookingReconciliationKey, lock: BookingReconciliationLock): Promise<BookingReconciliationMutation>;
  attachPatientId(key: BookingReconciliationKey, patientId: number): Promise<BookingReconciliationMutation>;
  clear(key: BookingReconciliationKey): Promise<BookingReconciliationMutation>;
}

export interface BookingReconciliationCoordinator {
  /** Repository passed to the runtime loop. Hidden reconciliation state is stripped on read and preserved on save. */
  stateRepository: BookingProcessStateRepository;
  /** Safety boundary used by booking.apply before any external write. */
  guard: BookingReconciliationGuard;
}

type PersistedBookingProcessState = Partial<BookingProcessState> & {
  [RECONCILIATION_FIELD]?: unknown;
};

interface Snapshot {
  visible: Partial<BookingProcessState> | null;
  lock: BookingReconciliationLock | null;
  malformed_lock: boolean;
}

// Production persistence is contact-scoped (clinic_id + contact_id). case_id is
// intentionally excluded so one unresolved write blocks every case for that contact.
function keyString(key: BookingReconciliationKey): string {
  return `${key.clinic_id}:${key.contact_id ?? ""}`;
}

function validateKey(key: BookingReconciliationKey): string | null {
  if (!key.clinic_id) return "clinic_id is required for durable booking reconciliation";
  if (!key.contact_id) return "contact_id is required for durable booking reconciliation";
  return null;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseLock(value: unknown): { lock: BookingReconciliationLock | null; malformed: boolean } {
  if (value === undefined || value === null) return { lock: null, malformed: false };
  if (typeof value !== "object" || Array.isArray(value)) return { lock: null, malformed: true };

  const raw = value as Record<string, unknown>;
  if (
    raw.status !== "pending"
    || typeof raw.armed_at !== "string"
    || raw.reason !== "write_in_flight_or_outcome_unknown"
    || typeof raw.date !== "string"
    || typeof raw.time_start !== "string"
    || typeof raw.time_end !== "string"
    || !isPositiveFiniteNumber(raw.doctor_id)
    || !isPositiveFiniteNumber(raw.cabinet_id)
  ) {
    return { lock: null, malformed: true };
  }

  if (raw.patient_id !== undefined && !isPositiveFiniteNumber(raw.patient_id)) {
    return { lock: null, malformed: true };
  }
  if (raw.service_interest !== undefined && raw.service_interest !== null && typeof raw.service_interest !== "string") {
    return { lock: null, malformed: true };
  }

  return {
    malformed: false,
    lock: {
      status: "pending",
      armed_at: raw.armed_at,
      reason: "write_in_flight_or_outcome_unknown",
      date: raw.date,
      time_start: raw.time_start,
      time_end: raw.time_end,
      doctor_id: raw.doctor_id,
      cabinet_id: raw.cabinet_id,
      ...(raw.service_interest !== undefined ? { service_interest: raw.service_interest as string | null } : {}),
      ...(raw.patient_id !== undefined ? { patient_id: raw.patient_id } : {}),
    },
  };
}

function locksEqual(a: BookingReconciliationLock | null, b: BookingReconciliationLock): boolean {
  return !!a
    && a.status === b.status
    && a.armed_at === b.armed_at
    && a.reason === b.reason
    && a.date === b.date
    && a.time_start === b.time_start
    && a.time_end === b.time_end
    && a.doctor_id === b.doctor_id
    && a.cabinet_id === b.cabinet_id
    && a.service_interest === b.service_interest
    && a.patient_id === b.patient_id;
}

function splitPersistedState(state: Partial<BookingProcessState> | null): Snapshot {
  if (!state) return { visible: null, lock: null, malformed_lock: false };
  const raw = state as PersistedBookingProcessState;
  const parsed = parseLock(raw[RECONCILIATION_FIELD]);
  const visible = { ...raw } as Record<string, unknown>;
  delete visible[RECONCILIATION_FIELD];
  return {
    visible: visible as Partial<BookingProcessState>,
    lock: parsed.lock,
    malformed_lock: parsed.malformed,
  };
}

function mergePersistedState(
  visible: Partial<BookingProcessState> | null,
  lock: BookingReconciliationLock | null,
): BookingProcessState {
  const merged: Record<string, unknown> = { ...(visible ?? {}) };
  if (lock) merged[RECONCILIATION_FIELD] = lock;
  return merged as unknown as BookingProcessState;
}

export function createBookingReconciliationCoordinator(
  base: BookingProcessStateRepository,
): BookingReconciliationCoordinator {
  const cache = new Map<string, Snapshot>();

  async function loadSnapshot(key: BookingReconciliationKey): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string }> {
    const invalid = validateKey(key);
    if (invalid) return { ok: false, reason: invalid };

    let loadError: string | null = null;
    const loaded = await base.loadState(key, (info) => {
      if (!info.loaded && info.reason === "rpc_error") {
        loadError = info.error ?? "booking process state repository load failed";
      }
    });
    if (loadError) {
      cache.delete(keyString(key));
      return { ok: false, reason: loadError };
    }

    const snapshot = splitPersistedState(loaded);
    cache.set(keyString(key), snapshot);
    if (snapshot.malformed_lock) {
      return { ok: false, reason: "persisted booking reconciliation lock is malformed; fail closed" };
    }
    return { ok: true, snapshot };
  }

  async function getSnapshot(key: BookingReconciliationKey): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string }> {
    const invalid = validateKey(key);
    if (invalid) return { ok: false, reason: invalid };
    const cached = cache.get(keyString(key));
    if (cached) {
      if (cached.malformed_lock) {
        return { ok: false, reason: "persisted booking reconciliation lock is malformed; fail closed" };
      }
      return { ok: true, snapshot: cached };
    }
    return loadSnapshot(key);
  }

  async function saveRaw(
    key: BookingReconciliationKey,
    visible: Partial<BookingProcessState> | null,
    lock: BookingReconciliationLock | null,
  ): Promise<BookingReconciliationMutation> {
    let saveError: string | null = null;
    await base.saveState(key, mergePersistedState(visible, lock), (info) => {
      if (!info.saved) saveError = info.error ?? "booking process state repository save failed";
    });
    if (saveError) return { ok: false, reason: saveError };
    return { ok: true };
  }

  const stateRepository: BookingProcessStateRepository = {
    async loadState(key, onDebug) {
      let loadFailed = false;
      const loaded = await base.loadState(key, (info) => {
        if (!info.loaded && info.reason === "rpc_error") loadFailed = true;
        onDebug?.(info);
      });

      const snapshot = splitPersistedState(loaded);
      if (loadFailed) {
        // Never cache an RPC failure as an authoritative "no lock" result. The booking
        // boundary will retry the repository read and fail closed if the error persists.
        cache.delete(keyString(key));
      } else {
        cache.set(keyString(key), snapshot);
      }
      return snapshot.visible;
    },

    async saveState(key, state, onDebug) {
      const existing = await getSnapshot(key);
      if (!existing.ok) {
        onDebug?.({ saved: false, error: existing.reason });
        return;
      }

      let saved = true;
      let saveError: string | undefined;
      await base.saveState(key, mergePersistedState(state, existing.snapshot.lock), (info) => {
        saved = info.saved;
        saveError = info.error;
        onDebug?.(info);
      });
      if (saved) {
        cache.set(keyString(key), {
          visible: state,
          lock: existing.snapshot.lock,
          malformed_lock: false,
        });
      } else if (!saveError) {
        onDebug?.({ saved: false, error: "booking process state repository save failed" });
      }
    },
  };

  const guard: BookingReconciliationGuard = {
    async getPending(key) {
      const current = await getSnapshot(key);
      if (!current.ok) return current;
      return { ok: true, lock: current.snapshot.lock };
    },

    async arm(key, lock) {
      const current = await getSnapshot(key);
      if (!current.ok) return current;
      if (current.snapshot.lock) {
        return { ok: false, reason: "booking reconciliation is already pending" };
      }

      const saved = await saveRaw(key, current.snapshot.visible, lock);
      if (!saved.ok) return saved;

      // Write-ahead safety requires durable proof before ClinicCard is mutated.
      // Re-read the persisted state instead of trusting a best-effort save callback.
      cache.delete(keyString(key));
      const confirmed = await loadSnapshot(key);
      if (!confirmed.ok) return confirmed;
      if (!locksEqual(confirmed.snapshot.lock, lock)) {
        return { ok: false, reason: "booking reconciliation lock was not durably persisted as written" };
      }
      cache.set(keyString(key), confirmed.snapshot);
      return { ok: true };
    },

    async attachPatientId(key, patientId) {
      if (!isPositiveFiniteNumber(patientId)) {
        return { ok: false, reason: "patient_id must be a positive number for booking reconciliation" };
      }

      const current = await getSnapshot(key);
      if (!current.ok) return current;
      const existingLock = current.snapshot.lock;
      if (!existingLock) {
        return { ok: false, reason: "booking reconciliation is not pending" };
      }
      if (existingLock.patient_id !== undefined) {
        return existingLock.patient_id === patientId
          ? { ok: true }
          : { ok: false, reason: "booking reconciliation patient_id conflicts with the pending lock" };
      }

      const updatedLock: BookingReconciliationLock = { ...existingLock, patient_id: patientId };
      const saved = await saveRaw(key, current.snapshot.visible, updatedLock);
      if (!saved.ok) return saved;

      // Like arm/clear, patient binding is safety-relevant. Prove it durably before
      // a later turn is allowed to use that id as reconciliation evidence.
      cache.delete(keyString(key));
      const confirmed = await loadSnapshot(key);
      if (!confirmed.ok) return confirmed;
      if (!locksEqual(confirmed.snapshot.lock, updatedLock)) {
        return { ok: false, reason: "booking reconciliation patient_id was not durably persisted" };
      }
      cache.set(keyString(key), confirmed.snapshot);
      return { ok: true };
    },

    async clear(key) {
      const current = await getSnapshot(key);
      if (!current.ok) return current;
      if (!current.snapshot.lock) return { ok: true };

      const previousSnapshot = current.snapshot;
      const saved = await saveRaw(key, current.snapshot.visible, null);
      if (!saved.ok) return saved;

      // Unlock is safety-relevant too. Prove the hidden lock is actually gone before
      // allowing this process to treat the contact as writable again.
      cache.delete(keyString(key));
      const confirmed = await loadSnapshot(key);
      if (!confirmed.ok) {
        cache.set(keyString(key), previousSnapshot);
        return confirmed;
      }
      if (confirmed.snapshot.lock) {
        cache.set(keyString(key), previousSnapshot);
        return { ok: false, reason: "booking reconciliation lock clear was not durably persisted" };
      }
      cache.set(keyString(key), confirmed.snapshot);
      return { ok: true };
    },
  };

  return { stateRepository, guard };
}
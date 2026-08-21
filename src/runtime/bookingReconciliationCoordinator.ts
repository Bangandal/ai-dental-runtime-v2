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

function keyString(key: BookingReconciliationKey): string {
  return `${key.clinic_id}:${key.contact_id ?? ""}:${key.case_id ?? ""}`;
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
    if (loadError) return { ok: false, reason: loadError };

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
      let forwarded: Parameters<NonNullable<typeof onDebug>>[0] | null = null;
      const loaded = await base.loadState(key, (info) => {
        forwarded = info;
        onDebug?.(info);
      });
      if (!forwarded && !loaded) onDebug?.({ loaded: false, reason: "null_or_missing" });

      const snapshot = splitPersistedState(loaded);
      cache.set(keyString(key), snapshot);
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
      if (!confirmed.snapshot.lock) {
        return { ok: false, reason: "booking reconciliation lock was not durably persisted" };
      }
      cache.set(keyString(key), confirmed.snapshot);
      return { ok: true };
    },

    async clear(key) {
      const current = await getSnapshot(key);
      if (!current.ok) return current;
      if (!current.snapshot.lock) return { ok: true };

      const saved = await saveRaw(key, current.snapshot.visible, null);
      if (!saved.ok) return saved;
      cache.set(keyString(key), {
        visible: current.snapshot.visible,
        lock: null,
        malformed_lock: false,
      });
      return { ok: true };
    },
  };

  return { stateRepository, guard };
}

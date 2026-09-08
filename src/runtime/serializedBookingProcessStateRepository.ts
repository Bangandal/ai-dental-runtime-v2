import type {
  BookingProcessState,
  BookingProcessStateRepository,
} from "./bookingProcessState.ts";

function keyString(key: { clinic_id: string; contact_id?: string | null }): string {
  return `${key.clinic_id}:${key.contact_id ?? ""}`;
}

function stateSignature(state: BookingProcessState): string {
  return JSON.stringify(state);
}

/**
 * Storage-boundary ordering for booking process state.
 *
 * The legacy loop may schedule state saves without awaiting them and may schedule the
 * same final state more than once. This wrapper preserves invocation order per contact,
 * makes reads wait for already-scheduled writes, and skips only a state that is known to
 * have been durably saved. Booking/reconciliation semantics remain owned by the wrapped
 * repository; this layer only removes write races and duplicate identical writes.
 */
export function createSerializedBookingProcessStateRepository(
  base: BookingProcessStateRepository,
): BookingProcessStateRepository {
  const tails = new Map<string, Promise<void>>();
  const lastDurableSignature = new Map<string, string>();

  return {
    async loadState(key, onDebug) {
      const queueKey = keyString(key);
      await (tails.get(queueKey) ?? Promise.resolve()).catch(() => undefined);
      return base.loadState(key, onDebug);
    },

    async saveState(key, state, onDebug) {
      const queueKey = keyString(key);
      const signature = stateSignature(state);
      const previous = tails.get(queueKey) ?? Promise.resolve();

      const current = previous
        .catch(() => undefined)
        .then(async () => {
          if (lastDurableSignature.get(queueKey) === signature) {
            onDebug?.({ saved: true });
            return;
          }

          let durablySaved = false;
          await base.saveState(key, state, (info) => {
            durablySaved = info.saved;
            onDebug?.(info);
          });
          if (durablySaved) {
            lastDurableSignature.set(queueKey, signature);
          }
        });

      tails.set(queueKey, current);
      try {
        await current;
      } finally {
        if (tails.get(queueKey) === current) {
          tails.delete(queueKey);
        }
      }
    },
  };
}

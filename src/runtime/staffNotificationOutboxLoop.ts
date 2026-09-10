import type { StaffNotificationOutboxWorker } from "./staffNotificationOutboxWorker.ts";

export interface StaffNotificationOutboxLoop {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export function createStaffNotificationOutboxLoop(input: {
  worker: StaffNotificationOutboxWorker;
  pollMs?: number;
  onError?: (error: unknown) => void;
}): StaffNotificationOutboxLoop {
  const pollMs = Math.max(1_000, Math.trunc(input.pollMs ?? 5_000));
  let timer: NodeJS.Timeout | null = null;
  let activeRun = false;

  async function tick(): Promise<void> {
    if (activeRun) return;
    activeRun = true;
    try {
      await input.worker.runOnce();
    } catch (error) {
      input.onError?.(error);
    } finally {
      activeRun = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, pollMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
  };
}

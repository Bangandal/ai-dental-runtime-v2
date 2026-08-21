export interface RuntimeTurnSerialIdentity {
  clinic_code?: string;
  channel?: string;
  external_user_id?: string;
  chat_id?: string;
}

export interface RuntimeTurnSerialQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export function createRuntimeTurnSerialQueue(): RuntimeTurnSerialQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      let releaseCurrent!: () => void;
      const currentGate = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const currentTail = previous.catch(() => undefined).then(() => currentGate);
      tails.set(key, currentTail);

      await previous.catch(() => undefined);
      try {
        return await task();
      } finally {
        releaseCurrent();
        if (tails.get(key) === currentTail) {
          tails.delete(key);
        }
      }
    },
  };
}

export function buildRuntimeTurnSerialKey(body: RuntimeTurnSerialIdentity): string | null {
  const clinic = body.clinic_code?.trim();
  const channel = body.channel?.trim();
  const contact = body.external_user_id?.trim() || body.chat_id?.trim();
  if (!clinic || !channel || !contact) return null;
  return JSON.stringify([clinic, channel, contact]);
}

export async function runRuntimeTurnSerialized<T>(input: {
  body: RuntimeTurnSerialIdentity;
  queue?: RuntimeTurnSerialQueue;
  task: () => Promise<T>;
}): Promise<T> {
  const key = buildRuntimeTurnSerialKey(input.body);
  if (!input.queue || !key) {
    return input.task();
  }
  return input.queue.run(key, input.task);
}

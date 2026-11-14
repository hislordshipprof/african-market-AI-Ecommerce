const inflight = new Map<string, Promise<string>>();
const holds = new Map<string, Promise<void>>();
const waiting = new Map<string, number>();

/**
 * Concurrent first-cart creates for the same shopper share one cart.
 * The map is filled before the create awaits, and it is dropped once that
 * create settles so a later cookie-less call can open a different cart.
 */
export function shareFirstCart(key: string, create: () => Promise<string>): Promise<string> {
  const current = inflight.get(key);
  if (current) return current;
  let resolve!: (id: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  inflight.set(key, promise);
  void (async () => {
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
    try {
      const hold = holds.get(key);
      if (hold) await hold;
      resolve(await create());
    } catch (error) {
      reject(error);
    } finally {
      waiting.set(key, Math.max(0, (waiting.get(key) ?? 1) - 1));
      if (inflight.get(key) === promise) inflight.delete(key);
    }
  })();
  return promise;
}

export function holdCartBootstrap(key: string): void {
  if (holds.has(key)) return;
  let release!: () => void;
  holds.set(key, new Promise<void>((resolve) => {
    release = resolve;
  }));
  releaseFns.set(key, release);
}

const releaseFns = new Map<string, () => void>();

export function releaseCartBootstrap(key: string): void {
  releaseFns.get(key)?.();
  releaseFns.delete(key);
  holds.delete(key);
}

export function cartBootstrapWaiting(key: string): number {
  return waiting.get(key) ?? 0;
}

export function resetCartBootstrap(): void {
  inflight.clear();
  holds.clear();
  waiting.clear();
  releaseFns.clear();
}

/**
 * Inngest's test step. `attempts` is how many times `run` calls `fn` before rethrowing (default 1).
 * `onSleepUntil` runs at each sleepUntil, as the moment the real sleep wakes.
 */
export function makeFakeStep(options?: { attempts?: number; onSleepUntil?: (until: Date) => Promise<void> | void }) {
  const attempts = options?.attempts ?? 1;
  const sleeps: Array<{ name: string; duration: string }> = [];
  const sleepUntils: Array<{ name: string; until: string }> = [];
  const sleepNames: string[] = [];
  const runs: string[] = [];
  return {
    sleeps,
    sleepUntils,
    sleepNames,
    runs,
    async sleep(name: string, duration: string) {
      sleeps.push({ name, duration });
      sleepNames.push(name);
    },
    async sleepUntil(name: string, time: Date) {
      sleepUntils.push({ name, until: time.toISOString() });
      sleepNames.push(name);
      await options?.onSleepUntil?.(time);
    },
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      runs.push(name);
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          return await fn();
        } catch (err) {
          last = err;
          if (i === attempts - 1) throw err;
        }
      }
      throw last;
    },
  };
}

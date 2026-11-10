/** Inngest's test step. `attempts` is how many times `run` calls `fn` before rethrowing (default 1). */
export function makeFakeStep(options?: { attempts?: number }) {
  const attempts = options?.attempts ?? 1;
  const sleeps: Array<{ name: string; duration: string }> = [];
  const sleepNames: string[] = [];
  const runs: string[] = [];
  return {
    sleeps,
    sleepNames,
    runs,
    async sleep(name: string, duration: string) {
      sleeps.push({ name, duration });
      sleepNames.push(name);
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

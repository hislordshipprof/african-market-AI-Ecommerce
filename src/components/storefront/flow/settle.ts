export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "rejected" | "timeout" };

/**
 * Runs async work that must never leave the UI hanging: it always settles, either
 * with the resolved value, or with a failure if the work rejects or does not settle
 * within `timeoutMs`. A late result after a timeout is ignored (#708 AC2b).
 */
export function settleWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (settled: Settled<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    run().then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, reason: "rejected" }),
    );
  });
}

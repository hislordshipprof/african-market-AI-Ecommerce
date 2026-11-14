type Refresh = () => Promise<void>;

const current = new Map<string, Refresh>();
const pending = new Map<string, ReturnType<typeof setTimeout>[]>();

/** The live cart provider registers itself. A remount replaces the previous refresh. */
export function bindCartRefresh(storeId: string, refresh: Refresh): () => void {
  current.set(storeId, refresh);
  if (pending.has(storeId)) void refresh();
  return () => {
    if (current.get(storeId) === refresh) current.delete(storeId);
  };
}

/** Refresh only the store that still has a mounted provider. */
export function refreshStoreCart(storeId: string): Promise<void> {
  return current.get(storeId)?.() ?? Promise.resolve();
}

/** Only a finished reply drops the late reads. An error, abort, or disconnect may still commit. */
export function shouldSettleTurn(flags: { isAbort: boolean; isDisconnect: boolean; isError: boolean }): boolean {
  return !flags.isAbort && !flags.isDisconnect && !flags.isError;
}

/** A turn ended cleanly. Drop any late reads still queued for it. */
export function settleStoreCart(storeId: string): Promise<void> {
  for (const timer of pending.get(storeId) ?? []) clearTimeout(timer);
  pending.delete(storeId);
  return refreshStoreCart(storeId);
}

/**
 * The server may still commit after the client has already read.
 * Read now, again when a provider mounts, and twice more inside 2.5s.
 */
export function reconcileStoreCart(storeId: string): void {
  void refreshStoreCart(storeId);
  for (const timer of pending.get(storeId) ?? []) clearTimeout(timer);
  pending.set(storeId, [400, 1200, 2500].map((delay) => setTimeout(() => {
    void refreshStoreCart(storeId);
  }, delay)));
}

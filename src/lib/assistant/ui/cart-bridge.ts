type Refresh = () => Promise<void>;

const current = new Map<string, Refresh>();

/** The live cart provider registers itself. A remount replaces the previous refresh. */
export function bindCartRefresh(storeId: string, refresh: Refresh): () => void {
  current.set(storeId, refresh);
  return () => {
    if (current.get(storeId) === refresh) current.delete(storeId);
  };
}

/** Refresh only the store that still has a mounted provider. */
export function refreshStoreCart(storeId: string): Promise<void> {
  return current.get(storeId)?.() ?? Promise.resolve();
}

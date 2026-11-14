const hiddenStores = new Set<string>();

/** Hide the launcher for this store until the next full page load. */
export function hideAssistantForStore(storeId: string): void {
  hiddenStores.add(storeId);
}

export function assistantHiddenForStore(storeId: string): boolean {
  return hiddenStores.has(storeId);
}

export function resetAssistantHidden(): void {
  hiddenStores.clear();
}

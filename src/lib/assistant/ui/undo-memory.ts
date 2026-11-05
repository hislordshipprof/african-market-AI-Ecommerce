type UndoLabel = "undone" | "already_removed";

const remembered = new Map<string, Record<string, UndoLabel>>();

/** Undo labels for this store, kept until a full page load. */
export function undoLabelsForStore(storeId: string): Record<string, UndoLabel> {
  return remembered.get(storeId) ?? {};
}

export function replaceUndoLabels(storeId: string, labels: Record<string, UndoLabel>): void {
  remembered.set(storeId, labels);
}

export function resetUndoLabels(): void {
  remembered.clear();
}

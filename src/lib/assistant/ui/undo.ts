export type UndoPlan =
  | { action: "wait" }
  | { action: "skip"; label: "Already removed" | "Undone" }
  | { action: "submit"; lineId: string; added: number; additionId: string };

/**
 * Decides whether Undo may call the server. A failed cart read is not proof
 * the line is gone, and a consumed addition is not submitted again.
 */
export function planUndo(input: {
  read: "confirmed" | "failed";
  line: { lineId: string; qty: number } | null;
  added: number;
  additionId: string;
  consumed: boolean;
}): UndoPlan {
  if (input.consumed) return { action: "skip", label: "Undone" };
  if (input.read === "failed") return { action: "wait" };
  if (!input.line || input.line.lineId.length === 0) {
    return { action: "skip", label: "Already removed" };
  }
  if (!Number.isInteger(input.added) || input.added < 1) return { action: "wait" };
  return {
    action: "submit",
    lineId: input.line.lineId,
    added: input.added,
    additionId: input.additionId,
  };
}

export type UndoAck =
  | { status: "confirmed"; qty: number; removed: boolean }
  | { status: "already_consumed"; subtracted: number }
  | { status: "already_removed" }
  | { status: "rejected" }
  | { status: "failed" };

/** The card says Undone only after a write that actually subtracted. A failed refresh does not undo that. */
export function undoCardAfter(ack: UndoAck, refresh: "ok" | "failed"): "undone" | "already_removed" | "unchanged" {
  void refresh;
  if (ack.status === "confirmed") return "undone";
  if (ack.status === "already_consumed") return ack.subtracted > 0 ? "undone" : "already_removed";
  if (ack.status === "already_removed") return "already_removed";
  return "unchanged";
}

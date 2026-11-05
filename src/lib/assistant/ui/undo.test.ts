import { describe, expect, it } from "vitest";
import { planUndo, undoCardAfter } from "./undo";

describe("assistant undo plan", () => {
  it("undo subtracts only what the assistant added", () => {
    expect(planUndo({
      read: "confirmed",
      line: { lineId: "line-1", qty: 3 },
      added: 2,
      additionId: "call:0",
      consumed: false,
    })).toEqual({ action: "submit", lineId: "line-1", added: 2, additionId: "call:0" });

    expect(planUndo({
      read: "confirmed",
      line: { lineId: "line-1", qty: 1 },
      added: 2,
      additionId: "call:0",
      consumed: true,
    })).toEqual({ action: "skip", label: "Undone" });

    expect(planUndo({
      read: "confirmed",
      line: null,
      added: 2,
      additionId: "call:0",
      consumed: false,
    })).toEqual({ action: "skip", label: "Already removed" });

    expect(planUndo({
      read: "failed",
      line: null,
      added: 2,
      additionId: "call:0",
      consumed: false,
    })).toEqual({ action: "wait" });
  });

  it("shows Undone only after the write is acknowledged", () => {
    expect(undoCardAfter({ status: "confirmed", qty: 1, removed: false }, "failed")).toBe("undone");
    expect(undoCardAfter({ status: "already_consumed" }, "failed")).toBe("undone");
    expect(undoCardAfter({ status: "rejected" }, "ok")).toBe("unchanged");
    expect(undoCardAfter({ status: "failed" }, "ok")).toBe("unchanged");
    expect(undoCardAfter({ status: "already_removed" }, "ok")).toBe("unchanged");
  });
});

import { describe, expect, it } from "vitest";
import { replaceUndoLabels, resetUndoLabels, undoLabelsForStore } from "./undo-memory";

describe("undo labels across a remount", () => {
  it("keeps a store's consumed addition and drops it for another store", () => {
    resetUndoLabels();
    replaceUndoLabels("store-a", { "call:0": "undone" });
    expect(undoLabelsForStore("store-a")).toEqual({ "call:0": "undone" });
    expect(undoLabelsForStore("store-b")).toEqual({});
    resetUndoLabels();
    expect(undoLabelsForStore("store-a")).toEqual({});
  });
});

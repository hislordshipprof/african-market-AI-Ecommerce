import { describe, expect, it } from "vitest";
import { assistantHiddenForStore, hideAssistantForStore, resetAssistantHidden } from "./session-hide";

describe("assistant launcher hide", () => {
  it("hides one store until a full reload and leaves the other store alone", () => {
    resetAssistantHidden();
    hideAssistantForStore("mama");
    expect(assistantHiddenForStore("mama")).toBe(true);
    expect(assistantHiddenForStore("tante")).toBe(false);
    resetAssistantHidden();
    expect(assistantHiddenForStore("mama")).toBe(false);
  });
});

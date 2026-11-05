import { describe, expect, it } from "vitest";
import { completionAnnouncement } from "./announce";

describe("assistant completion announcement", () => {
  it("reads the reply and a short card summary", () => {
    expect(completionAnnouncement({
      parts: [{ type: "text", text: "Egusi is in the grains aisle." }],
    })).toBe("Egusi is in the grains aisle.");
    expect(completionAnnouncement({
      parts: [
        { type: "text", text: "Here is what I found." },
        {
          type: "tool-show_products",
          toolCallId: "p",
          state: "output-available",
          output: { ok: true, cards: [{ listingId: "l", name: "Egusi", priceCents: 1099, imageUrl: null }] },
        },
      ],
    })).toContain("Here is what I found.");
    expect(completionAnnouncement({ parts: [] })).toBe("Reply ready");
  });
});

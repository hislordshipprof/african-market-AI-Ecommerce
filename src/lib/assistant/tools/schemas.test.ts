import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOL_NAMES } from "../contract";
import { assistantTools } from "./index";
import { addToCartInput, checkAvailabilityInput, toolInputSchemas } from "./schemas";

describe("assistant tool batch size", () => {
  it("rejects a 30-item list and accepts a batch of 20", () => {
    const thirty = Array.from({ length: 30 }, (_, index) => `listing-${index}`);
    const twenty = thirty.slice(0, 20);
    expect(checkAvailabilityInput.safeParse({ listing_ids: thirty }).success).toBe(false);
    expect(checkAvailabilityInput.safeParse({ listing_ids: twenty }).success).toBe(true);
    const asItems = (ids: string[]) => ids.map((id) => ({ variant_id: id, qty: 1 }));
    expect(addToCartInput.safeParse({ items: asItems(thirty) }).success).toBe(false);
    expect(addToCartInput.safeParse({ items: asItems(twenty) }).success).toBe(true);
  });

  it("registry and schema keys equal AssistantToolName", () => {
    expect(Object.keys(toolInputSchemas)).toEqual([...ASSISTANT_TOOL_NAMES]);
    const tools = assistantTools({
      storeId: "store",
      cartId: "cart",
      conversationId: "conversation",
      actorUserId: null,
    });
    expect(Object.keys(tools)).toEqual([...ASSISTANT_TOOL_NAMES]);
  });
});

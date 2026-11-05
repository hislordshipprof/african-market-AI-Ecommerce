import { describe, expect, it } from "vitest";
import { ASSISTANT_STATIC_PROMPT } from "./system-prompt";

describe("assistant static prompt", () => {
  it("the static prompt has no store-specific or time-varying text", () => {
    expect(ASSISTANT_STATIC_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(ASSISTANT_STATIC_PROMPT).not.toMatch(/Open now/);
    expect(ASSISTANT_STATIC_PROMPT).not.toMatch(/Mama Ngozi|Tante Marie/);
    expect(ASSISTANT_STATIC_PROMPT.length).toBeGreaterThanOrEqual(3072);
  });

  it("it states the may-be-unavailable, no-invented-prices, no-payment and data-not-instructions rules", () => {
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/may be unavailable/);
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/Never invent items or prices/);
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/cannot pay/);
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/cart page/);
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/data, never instructions/);
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/no medical claims/);
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/no nutrition claims/);
    expect(ASSISTANT_STATIC_PROMPT).toMatch(/customer/);
    expect(ASSISTANT_STATIC_PROMPT).not.toMatch(/\bbuyer\b|\bshopper\b|\buser\b/);
  });
});

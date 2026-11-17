import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stepperLimit } from "@/lib/storefront/cart-quantity";
import { QuickAddStepperView } from "./quick-add-stepper";

const item = { listingId: "l1", variantId: "v1", name: "Yellow Garri", price: 399, maxPerOrder: 2 };

function render(qty: number, overrides: Partial<typeof item> = {}, disabled = false) {
  const current = { ...item, ...overrides };
  return renderToStaticMarkup(
    createElement(QuickAddStepperView, {
      item: current,
      qty,
      limit: stepperLimit({ qty, max: current.maxPerOrder, available: true, variantId: current.variantId }),
      disabled,
      reasonId: "why",
      onStep: () => {},
    }),
  );
}

const button = (html: string, testId: string) => html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe("quick-add stepper limits (#708 P1, #717 AC1)", () => {
  it("at the ceiling turns off plus only, and shows the limit beside it", () => {
    const html = render(2);
    expect(button(html, "stepper-plus")).toContain("disabled");
    expect(button(html, "stepper-plus")).toContain('aria-describedby="why"');
    expect(button(html, "stepper-minus")).not.toContain("disabled");
    // Visible, not screen-reader-only.
    expect(html).toMatch(/<span[^>]*id="why"[^>]*>Limit 2 per order<\/span>/);
    expect(html).not.toMatch(/id="why"[^>]*class="sr-only"|class="sr-only"[^>]*id="why"/);
  });

  it("below the ceiling has no reason and plus works", () => {
    const html = render(1);
    expect(button(html, "stepper-plus")).not.toContain("disabled");
    expect(html).not.toContain('id="why"');
  });

  it("cannot add an item with no pack to order, and says why", () => {
    const html = render(0, { variantId: undefined });
    expect(button(html, "quick-add-btn")).toContain("disabled");
    expect(html).toContain("Not sold online yet");
  });

  it("leaves announcing to the one cart status, not the quantity cell", () => {
    expect(render(1)).not.toContain("aria-live");
  });
});

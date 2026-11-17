import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { basketLabel, CartTriggerView } from "./cart-trigger";

function render(count: number, loading = false) {
  return renderToStaticMarkup(
    createElement(CartTriggerView, { count, loading, onOpen: () => {} }),
  );
}

/** Pulls the button's aria-label (its accessible name) out of the static markup. */
function ariaLabel(html: string): string | null {
  return html.match(/aria-label="([^"]*)"/)?.[1] ?? null;
}

describe("cart button accessible name (#705)", () => {
  it("names the button '{n} item(s) in basket', singular at one", () => {
    expect(basketLabel(0)).toBe("0 items in basket");
    expect(basketLabel(1)).toBe("1 item in basket");
    expect(basketLabel(4)).toBe("4 items in basket");
  });

  it("the rendered accessible name matches the count for 0, 1 and 4", () => {
    expect(ariaLabel(render(0))).toBe("0 items in basket");
    expect(ariaLabel(render(1))).toBe("1 item in basket");
    expect(ariaLabel(render(4))).toBe("4 items in basket");
  });

  it("never doubles the digit: the visible badge is hidden from the name", () => {
    const html = render(4);
    // The only digit that reaches the accessible name is the one in the label.
    expect(ariaLabel(html)).toBe("4 items in basket");
    // The visible badge carries the digit too, but hidden so it is not read again.
    expect(html).toMatch(/aria-hidden="true"[^>]*>4<\/span>|<span[^>]*aria-hidden="true"[^>]*>4<\/span>/);
    expect(html).not.toContain("44");
  });

  it("shows a stable name while the server cart is still loading", () => {
    expect(ariaLabel(render(0, true))).toBe("Basket");
    // No real digit while loading, so nothing can be doubled.
    expect(render(0, true)).not.toContain(">0<");
  });
});

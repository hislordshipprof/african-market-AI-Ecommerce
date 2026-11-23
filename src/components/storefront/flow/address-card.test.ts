import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddressCard } from "./common";

const address = "12 Market St, Houston, TX 77002";

describe("AddressCard", () => {
  it("labels its map a demo map in the demo", () => {
    const html = renderToStaticMarkup(createElement(AddressCard, { address }));
    expect(html).toContain("Demo map");
  });

  it("does not call a real store's pickup address a demo (#740)", () => {
    const html = renderToStaticMarkup(
      createElement(AddressCard, { address, title: "Collect from the market", demo: false }),
    );
    expect(html).toContain(address);
    expect(html).not.toMatch(/demo/i);
  });
});

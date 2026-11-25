import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Next's loader gives a static image its size; vitest's does not.
vi.mock("../../../public/images/directory/store-admin-orders.webp", () => ({ default: { src: "/orders.webp", width: 600, height: 1200 } }));
vi.mock("../../../public/images/products/egusi-seeds-whole.webp", () => ({ default: { src: "/egusi.webp", width: 800, height: 800 } }));
vi.mock("../../../public/images/products/garri-yellow.webp", () => ({ default: { src: "/garri.webp", width: 800, height: 800 } }));
vi.mock("../../../public/images/products/palm-oil-red.webp", () => ({ default: { src: "/palm.webp", width: 800, height: 800 } }));

import { DirectoryHome } from "./directory-home";
import { DirectoryPlace } from "./directory-place";

const TEXAS = { code: "TX", name: "Texas", href: "/stores/texas", count: 1, cities: [{ name: "Houston", href: "/stores/texas/houston", count: 1 }] };

const home = (states: (typeof TEXAS)[]) => renderToStaticMarkup(createElement(DirectoryHome, { stores: [], states, plans: null, feeNote: "Prices are the market's own." }));
const footer = (html: string) => /<footer[^>]*>([\s\S]*)<\/footer>/.exec(html)?.[1] ?? "";

// State and city pages are reachable without a search or the sitemap (#810).
describe("directory links to its state pages", () => {
  it("the home links to every state with a listed store before any search", () => {
    const html = home([TEXAS, { ...TEXAS, code: "MD", name: "Maryland", href: "/stores/maryland" }]);
    expect(html).toContain('href="/stores/texas"');
    expect(html).toContain('href="/stores/maryland"');
  });

  it("the home links to each city page under its state (#863)", () => {
    expect(home([TEXAS])).toContain('href="/stores/texas/houston"');
  });

  it("the home names no state when no store is listed", () => {
    expect(home([])).not.toContain('href="/stores/');
  });

  it("the home footer links to the stores by state", () => {
    expect(footer(home([TEXAS]))).toMatch(/<a [^>]*href="\/#stores-by-state"[^>]*>Stores by state<\/a>/);
  });

  it("a state or city page's footer links back to the stores by state", () => {
    const html = renderToStaticMarkup(createElement(DirectoryPlace, { crumbs: [{ label: "Texas" }], title: "t", lede: "l", stores: [] }));
    expect(footer(html)).toMatch(/<a [^>]*href="\/#stores-by-state"[^>]*>Stores by state<\/a>/);
  });
});

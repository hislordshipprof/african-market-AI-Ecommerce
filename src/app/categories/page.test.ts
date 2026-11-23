import { describe, expect, it, vi } from "vitest";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The data boundary: no store row and no categories in the platform catalog.
vi.mock("@/lib/get-store", () => ({ getStore: async () => ({ id: "store-1", name: "Test Market" }) }));
vi.mock("@/lib/storefront/service", () => ({ listCategories: async () => [] }));

const { default: CategoriesPage } = await import("./page");

describe("/categories with no categories", () => {
  it("points the shopper to the store home, not back to /categories", async () => {
    const shell = (await CategoriesPage()) as ReactElement<{ children: ReactNode }>;
    expect(isValidElement(shell)).toBe(true);
    const html = renderToStaticMarkup(createElement(Fragment, null, shell.props.children));
    expect(html).toContain("The aisles are being stocked");
    expect(html).toMatch(/href="\/"/);
    expect(html).not.toMatch(/href="\/categories"/);
  });
});

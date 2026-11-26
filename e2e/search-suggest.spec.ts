import { test, expect } from "@playwright/test";
import { storeUrl } from "./urls";

const BASE = storeUrl("mama-ngozi");

test.describe("search box suggests as you type (#835)", () => {
  test("shows suggested searches, aisles and products, and the keyboard walks them", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    const search = page.getByRole("combobox", { name: /search listings/i });
    await search.fill("pal");
    const box = page.getByRole("listbox", { name: "Search suggestions" });
    const searches = box.getByRole("group", { name: "Suggested searches" });
    const palmOil = searches.getByRole("option", { name: "palm oil" });
    await expect(palmOil).toBeVisible();
    await expect(palmOil.locator("strong")).toHaveText("m oil");
    await expect(box.getByRole("group", { name: "Aisles" }).getByRole("option", { name: "Oils, Sauces & Condiments" })).toHaveAttribute(
      "href",
      "/categories/oils-sauces-and-condiments",
    );
    const products = box.getByRole("group", { name: "Products" });
    await expect(products.getByRole("option").first()).toContainText(/palm oil/i);
    await expect(products.getByTestId("quick-add-btn").first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /suggestion/ })).toHaveText(/1 suggestion, 1 aisle, 1 product/);

    await expect(search).toHaveAttribute("aria-expanded", "true");
    await search.press("ArrowDown");
    await expect(search).toHaveAttribute("aria-activedescendant", (await palmOil.getAttribute("id"))!);
    await expect(palmOil).toHaveAttribute("aria-selected", "true");
    await search.press("ArrowUp");
    await expect(box.getByRole("option", { name: "See all results" })).toHaveAttribute("aria-selected", "true");
    await search.press("Escape");
    await expect(search).toHaveAttribute("aria-expanded", "false");

    await search.press("ArrowDown");
    await expect(palmOil).toHaveAttribute("aria-selected", "true");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=palm%20oil$/);
  });

  test("a local name suggests the store's own product name", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator("#storefront-search").fill("ata");
    const searches = page.getByRole("group", { name: "Suggested searches" });
    await expect(searches.getByRole("option", { name: /scotch bonnet pepper/ })).toContainText("also called ata rodo");
  });

  test("Enter with no row highlighted searches the typed text, which then shows as a recent search", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    const search = page.locator("#storefront-search");
    await search.fill("egsi");
    await expect(page.getByRole("group", { name: "Products" }).getByRole("option").first()).toContainText(/egusi/i);
    await search.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=egsi$/);

    await page.goto(BASE, { waitUntil: "networkidle" });
    await search.focus();
    await expect(page.getByRole("group", { name: "Recent searches" }).getByRole("option", { name: "egsi" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Popular in this store" }).getByRole("option").first()).toBeVisible();
  });

  test("an older keystroke's slow answer never replaces a newer one", async ({ page }) => {
    await page.route(/\/api\/storefront\/search\?q=pa$/, async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    const search = page.locator("#storefront-search");
    const slow = page.waitForRequest(/\/api\/storefront\/search\?q=pa$/);
    await search.fill("pa");
    await slow;
    await search.fill("pal");
    const searches = page.getByRole("group", { name: "Suggested searches" });
    await expect(searches.getByRole("option")).toHaveText(["palm oil"]);
    await page.waitForTimeout(2_000);
    await expect(searches.getByRole("option")).toHaveText(["palm oil"]);
  });
});

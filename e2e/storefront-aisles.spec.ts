import { storeUrl } from "./urls";
import { test, expect, type Page } from "@playwright/test";

const BASE = storeUrl("mama-ngozi");
const phone = { width: 390, height: 844 };

/** Elements in main that scroll sideways, product rails aside. */
async function sidewaysScrollers(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("main *")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(el).overflowX))
      .filter((el) => !el.closest("[data-testid='product-rail']"))
      .map((el) => el.className || el.tagName),
  );
}

// #862: aisles B, the left rail and aisle sheet, popular names on home, no sideways strips.
test.describe("Storefront aisles B (#862)", () => {
  test("the header's Aisles button opens every aisle in a left drawer that traps focus and closes on Esc", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.getByRole("navigation", { name: "Store categories" })).toHaveCount(0);
    const button = page.getByRole("button", { name: "Aisles", exact: true });
    await button.click();
    const drawer = page.getByRole("dialog", { name: "Aisles" });
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
    const tree = drawer.getByTestId("aisle-tree-menu");
    const aisles = tree.locator(":scope > li");
    expect(await aisles.count()).toBeGreaterThan(8);
    await drawer.getByRole("button", { name: "Show Soup Ingredients sections" }).click();
    await expect(drawer.getByRole("link", { name: "All soup ingredients" })).toBeVisible();
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(button).toBeFocused();
  });

  test("the drawer's search narrows the tree to matching sections", async ({ page }) => {
    await page.goto(BASE);
    await page.getByRole("button", { name: "Aisles", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Aisles" });
    await drawer.getByLabel("Find an aisle or section").fill("egusi");
    await drawer.getByRole("link", { name: /Egusi & Melon Seeds/ }).click();
    await expect(page).toHaveURL(/\/categories\/egusi-and-melon-seeds$/);
  });

  test("desktop aisle pages keep the tree in a left rail whose sections filter, with refine filters below", async ({ page }) => {
    await page.goto(`${BASE}/categories/soup-ingredients`);
    const rail = page.getByRole("complementary", { name: "Aisles" });
    const all = rail.getByRole("link", { name: "All soup ingredients" });
    await expect(all).toHaveAttribute("aria-current", "page");
    const section = rail.getByTestId("aisle-tree-sub").first();
    const name = (await section.locator("span").first().innerText()).trim();
    const count = Number(await section.locator(".sf-tree-count").innerText());
    await section.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    const selected = rail.getByRole("link", { name: new RegExp(`^${name}`) });
    await expect(selected).toHaveAttribute("aria-current", "page");
    await expect(selected).toHaveCSS("box-shadow", /2px/);
    await expect(selected.locator("svg")).toBeVisible();
    await expect(page.getByTestId("listing-card")).toHaveCount(count);
    await rail.getByRole("region", { name: "Refine" }).getByTestId("filter-in-stock").click();
    await expect(page).toHaveURL(/stock=1/);
  });

  test("on a phone the Aisles tab opens the tree as a bottom sheet, clear of Shop with AI", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(BASE);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Aisles" }).click();
    const sheet = page.getByRole("dialog", { name: "Aisles" });
    await expect(sheet).toBeVisible();
    await expect.poll(async () => {
      const box = await sheet.boundingBox();
      return Math.round((box?.y ?? 0) + (box?.height ?? 0));
    }).toBe(phone.height);
    const close = sheet.getByRole("button", { name: "Close Aisles" });
    const closeBox = await close.boundingBox();
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    // The sheet is a modal dialog in the top layer: the point under its close button is the button itself.
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"), { x: closeBox!.x + 22, y: closeBox!.y + 22 });
    expect(hit).toBe("Close Aisles");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("phone aisle pages swap the chip strip for an aisle picker and a Filter button", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(`${BASE}/categories/soup-ingredients`);
    await expect(page.getByRole("complementary", { name: "Aisles" })).toBeHidden();
    await page.getByRole("button", { name: /Soup Ingredients\s*All soup ingredients/ }).click();
    const sheet = page.getByRole("dialog", { name: "Aisles" });
    await expect(sheet.getByRole("link", { name: "All soup ingredients" })).toHaveAttribute("aria-current", "page");
    await sheet.getByTestId("aisle-tree-sub").first().click();
    await expect(page).toHaveURL(/\/categories\/(?!soup-ingredients)/);
    await page.getByRole("button", { name: /^Filter/ }).click();
    const filter = page.getByRole("dialog", { name: "Filter" });
    await filter.getByTestId("filter-frozen").click();
    await expect(page).toHaveURL(/frozen=1/);
    expect(await sidewaysScrollers(page)).toEqual([]);
  });

  test("home shows popular names that wrap and search, aisle cards, and only product rails scroll sideways", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(BASE);
    await expect(page.getByTestId("market-band")).toHaveCount(0);
    const popular = page.getByTestId("popular-names");
    const chips = popular.getByRole("link");
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThan(2);
    const ul = popular.locator("ul");
    expect(await ul.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const aisles = page.getByTestId("category-mosaic");
    await expect(aisles.getByRole("button", { name: /^All \d+ aisles$/ })).toBeVisible();
    expect(await sidewaysScrollers(page)).toEqual([]);
    const first = (await chips.first().innerText()).trim();
    await chips.first().click();
    await expect(page).toHaveURL(new RegExp(`search\\?q=${encodeURIComponent(first.toLowerCase())}`));
    await expect(page.getByTestId("listing-card").first()).toBeVisible();
  });

  test("Cook tonight's Add all puts every item of a dish in the basket", async ({ page }) => {
    await page.goto(BASE);
    const dish = page.getByTestId("cook-tonight").getByTestId("dish").first();
    const add = dish.getByRole("button", { name: /^Add all \d+ .* items to basket$/ });
    const n = Number((await add.innerText()).match(/\d+/)?.[0]);
    expect(n).toBeGreaterThan(0);
    await add.click();
    await expect(dish.getByText("In basket")).toBeVisible();
    await expect(page.getByTestId("storefront-header").getByTestId("cart-count")).toHaveText(String(n));
  });
});

import { test, expect } from "@playwright/test";
import { storeOwnerSignIn } from "./store-owner-auth";

const DASHBOARD_URL = "/store-admin?store=mama-ngozi";

test.describe("Order desk (#725)", () => {
  test("the dashboard's first daily links are Orders, Messages, Products", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(DASHBOARD_URL);
    const links = page.getByRole("main").getByRole("link");
    await expect(links.first()).toBeVisible();
    // Payment and plan warnings sit above the cards in alert/status boxes; the cards start after them.
    const cards = await links.evaluateAll((els) =>
      els.filter((el) => !el.closest("[role=alert],[role=status]")).map((el) => new URL((el as HTMLAnchorElement).href).pathname),
    );
    expect(cards.slice(0, 3)).toEqual(["/store-admin/orders", "/store-admin/messages", "/store-admin/listings"]);
  });
});

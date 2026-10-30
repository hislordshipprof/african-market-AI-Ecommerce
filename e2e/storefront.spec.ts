import { test, expect } from "@playwright/test";

test.describe("Storefront brand rendering", () => {
  test("mama-ngozi store shows its own name and brand", async ({ page }) => {
    await page.goto("http://localhost:3000/?store=mama-ngozi");
    await expect(page.locator("h1")).toHaveText("Mama Ngozi African Market");
    await expect(page).toHaveTitle("Mama Ngozi African Market");
  });

  test("tante-marie store shows its own name and brand", async ({ page }) => {
    await page.goto("http://localhost:3000/?store=tante-marie");
    await expect(page.locator("h1")).toHaveText(
      "Tante Marie Caribbean Grocer",
    );
    await expect(page).toHaveTitle("Tante Marie Caribbean Grocer");
  });

  test("unknown store shows not-found page", async ({ page }) => {
    await page.goto("http://localhost:3000/?store=no-such-store");
    await expect(page.locator("h1")).toHaveText("Store not found");
  });

  test("no store parameter shows not-found page", async ({ page }) => {
    await page.goto("http://localhost:3000/");
    await expect(page.locator("h1")).toHaveText("Store not found");
  });

  test("stores render different theme colors", async ({ page }) => {
    await page.goto("http://localhost:3000/?store=mama-ngozi");
    const headerA = page.locator("header");
    const bgA = await headerA.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    await page.goto("http://localhost:3000/?store=tante-marie");
    const headerB = page.locator("header");
    const bgB = await headerB.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    expect(bgA).not.toBe(bgB);
  });
});

import { test, expect } from "@playwright/test";

test.describe("Storefront brand rendering (real subdomains)", () => {
  test("mama-ngozi store shows its own name and brand", async ({ page }) => {
    await page.goto("http://mama-ngozi.localhost:3000/");
    await expect(page.locator("h1")).toHaveText("Mama Ngozi African Market");
    await expect(page).toHaveTitle("Mama Ngozi African Market");
  });

  test("tante-marie store shows its own name and brand", async ({ page }) => {
    await page.goto("http://tante-marie.localhost:3000/");
    await expect(page.locator("h1")).toHaveText(
      "Tante Marie Caribbean Grocer",
    );
    await expect(page).toHaveTitle("Tante Marie Caribbean Grocer");
  });

  test("mama-ngozi logo renders", async ({ page }) => {
    await page.goto("http://mama-ngozi.localhost:3000/");
    const logo = page.locator("img[alt='Mama Ngozi African Market logo']");
    await expect(logo).toBeVisible();
  });

  test("tante-marie logo renders", async ({ page }) => {
    await page.goto("http://tante-marie.localhost:3000/");
    const logo = page.locator("img[alt='Tante Marie Caribbean Grocer logo']");
    await expect(logo).toBeVisible();
  });

  test("unknown store shows not-found page", async ({ page }) => {
    await page.goto("http://no-such-store.localhost:3000/");
    await expect(page.locator("h1")).toHaveText("Store not found");
  });

  test("bare localhost shows not-found page", async ({ page }) => {
    await page.goto("http://localhost:3000/");
    await expect(page.locator("h1")).toHaveText("Store not found");
  });

  test("stores render different theme colors", async ({ page }) => {
    await page.goto("http://mama-ngozi.localhost:3000/");
    const headerA = page.locator("header");
    const bgA = await headerA.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    await page.goto("http://tante-marie.localhost:3000/");
    const headerB = page.locator("header");
    const bgB = await headerB.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    expect(bgA).not.toBe(bgB);
  });

  test("?store= fallback works in development", async ({ page }) => {
    await page.goto("http://localhost:3000/?store=mama-ngozi");
    await expect(page.locator("h1")).toHaveText("Mama Ngozi African Market");
  });
});

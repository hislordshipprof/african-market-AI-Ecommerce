import { storeUrl } from "./urls";
import { test, expect } from "@playwright/test";

test.describe("Storefront brand rendering (real subdomains)", () => {
  test("mama-ngozi store shows its own name and brand", async ({ page }) => {
    await page.goto(`${storeUrl("mama-ngozi")}/`);
    await expect(page.locator("h1")).toHaveText("Mama Ngozi African Market");
    await expect(page).toHaveTitle("Mama Ngozi African Market");
  });

  test("tante-marie store shows its own name and brand", async ({ page }) => {
    await page.goto(`${storeUrl("tante-marie")}/`);
    await expect(page.locator("h1")).toHaveText(
      "Tante Marie Caribbean Grocer",
    );
    await expect(page).toHaveTitle("Tante Marie Caribbean Grocer");
  });

  test("mama-ngozi logo renders", async ({ page }) => {
    await page.goto(`${storeUrl("mama-ngozi")}/`);
    const logo = page.locator("img[alt='Mama Ngozi African Market logo']");
    await expect(logo).toBeVisible();
  });

  test("tante-marie logo renders", async ({ page }) => {
    await page.goto(`${storeUrl("tante-marie")}/`);
    const logo = page.locator("img[alt='Tante Marie Caribbean Grocer logo']");
    await expect(logo).toBeVisible();
  });

  test("unknown store shows not-found page", async ({ page }) => {
    await page.goto(`${storeUrl("no-such-store")}/`);
    await expect(page.locator("h1")).toHaveText("Store not found");
  });

  test("bare localhost shows not-found page", async ({ page }) => {
    await page.goto(`${storeUrl()}/`);
    await expect(page.locator("h1")).toHaveText("Store not found");
  });

  test("stores render different theme colors", async ({ page }) => {
    await page.goto(`${storeUrl("mama-ngozi")}/`);
    const headerA = page.getByTestId("storefront-header");
    const bgA = await headerA.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    await page.goto(`${storeUrl("tante-marie")}/`);
    const headerB = page.getByTestId("storefront-header");
    const bgB = await headerB.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    expect(bgA).not.toBe(bgB);
  });

  test("?store= fallback works in development", async ({ page }) => {
    test.skip(true, "requires next dev; e2e always uses next start (production mode)");
    await page.goto(`${storeUrl()}/?store=mama-ngozi`);
    await expect(page.locator("h1")).toHaveText("Mama Ngozi African Market");
  });

  test("?store= override is blocked in production mode", async ({ page }) => {
    test.skip(!!process.env.E2E_STORE_OVERRIDE, "E2E_STORE_OVERRIDE enables ?store= param");
    await page.goto(`${storeUrl()}/?store=mama-ngozi`);
    await expect(page.locator("h1")).toHaveText("Store not found");
  });

  test("dark mode switches to dark theme tokens", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${storeUrl("mama-ngozi")}/`);

    const bgColor = await page.locator("body").evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--store-bg").trim(),
    );
    expect(bgColor).toBe("#0D1410");
  });

  test("light mode uses light theme tokens", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${storeUrl("mama-ngozi")}/`);

    const bgColor = await page.locator("body").evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--store-bg").trim(),
    );
    expect(bgColor).toBe("#F3F4EF");
  });

  test("dark mode brand color passes WCAG AA contrast", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${storeUrl("mama-ngozi")}/`);

    const [primary, bg] = await page.locator("body").evaluate((el) => {
      const s = getComputedStyle(el);
      return [
        s.getPropertyValue("--store-primary").trim(),
        s.getPropertyValue("--store-bg").trim(),
      ];
    });

    function lum(hex: string): number {
      const rgb = [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
      ].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }

    const l1 = lum(primary);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

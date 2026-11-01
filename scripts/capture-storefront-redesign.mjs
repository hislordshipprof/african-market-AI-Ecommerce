import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run against pnpm start with E2E_STORE_OVERRIDE=1 (existing proxy opt-in).
// No production routing changes are needed for the requested ?store= URLs.
const baseURL = process.env.STOREFRONT_URL || "http://localhost:3000";
const output = resolve("screenshots/redesign");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const screens = [
  ["home", "/", "[data-testid=hero-carousel]"],
  ["category", "/categories/grains-and-flours", "[data-testid=listing-card]"],
  ["search", "/search?q=egusi", ".sf-search-results"],
  ["product", "/listings/mn_egusi", "[data-testid=product-detail]"],
  ["collection", "/collections/jollof-night", ".sf-collection-hero"],
  ["cart", "/categories/grains-and-flours", "[data-testid=listing-card]"],
];
try {
  for (const width of [390, 1440]) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
        colorScheme,
        reducedMotion: "reduce",
      });
      for (const [screen, path, selector] of screens) {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const url = new URL(path, baseURL);
        url.searchParams.set("store", "mama-ngozi");
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("store-name")).toHaveText(
          "Mama Ngozi African Market",
        );
        await expect(page.locator(selector).first()).toBeVisible();
        await page.evaluate(async () => {
          await document.fonts.ready;
          for (
            let top = 0;
            top < document.body.scrollHeight;
            top += innerHeight
          ) {
            scrollTo(0, top);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          scrollTo(0, 0);
        });
        if (screen === "cart") {
          await page
            .locator("[data-testid=quick-add-btn]:enabled")
            .first()
            .click();
          await page
            .getByTestId("storefront-header")
            .getByRole("button", { name: "Shopping cart", exact: true })
            .click();
          await expect(
            page.getByRole("dialog", { name: "Your cart" }),
          ).toBeVisible();
        }
        await expect
          .poll(
            () =>
              page
                .locator("img")
                .evaluateAll(
                  (images) =>
                    images.filter(
                      (image) =>
                        image.currentSrc &&
                        (!image.complete || !image.naturalWidth),
                    ).length,
                ),
            { timeout: 60000 },
          )
          .toBe(0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        expect(overflow, `${screen} horizontal overflow at ${width}px`).toBe(
          false,
        );
        expect(errors, `${screen} browser errors`).toEqual([]);
        const file = `${screen}-${width}px-${colorScheme}.png`;
        await page.screenshot({
          path: resolve(output, file),
          fullPage: screen !== "cart",
          animations: "disabled",
        });
        checks.push({ screen, width, colorScheme, file, overflow, errors });
        console.log(file);
        await page.close();
      }
      await context.close();
    }
  }
  await writeFile(
    resolve(output, "checks.json"),
    JSON.stringify(checks, null, 2) + "\n",
  );
} finally {
  await browser.close();
}

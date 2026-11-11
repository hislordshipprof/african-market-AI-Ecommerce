import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseURL = process.env.STOREFRONT_URL || "http://localhost:3000";
const output = resolve("screenshots/redesign");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const screens = [
  ["home-top", "/", "[data-testid=hero-carousel]"],
  ["home-mid", "/", "[data-testid=product-rail]"],
  ["home-bottom", "/", ".sf-footer"],
  ["category", "/categories/grains-and-flours", "[data-testid=listing-card]"],
  ["product", "/listings/mn_egusi", "[data-testid=product-detail]"],
  ["quick-view", "/categories/grains-and-flours", "[data-testid=listing-card]"],
  ["404", "/c/grains-flours", "[data-testid=page-not-found]"],
];
const scopedURL = path => {
  const url = new URL(path, baseURL);
  url.searchParams.set("store", "mama-ngozi");
  return url.href;
};
try {
  for (const width of [390, 1024, 1440, 1920]) for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme, reducedMotion: "no-preference" });
    try {
      for (const [screen, path, selector] of screens) {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(scopedURL(path), { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("store-name")).toHaveText("Mama Ngozi African Market");
        await expect(page.locator(selector).first()).toBeVisible();
        const pause = page.getByRole("button", { name: "Pause slideshow" });
        if (await pause.count()) await pause.click();
        if (screen === "home-mid" || screen === "home-bottom") await page.locator(selector).first().scrollIntoViewIfNeeded();
        if (screen === "quick-view") {
          const card = page.getByTestId("listing-card").filter({ hasText: "Egusi" }).first();
          await card.getByRole("button", { name: /Quick view/ }).focus();
          await card.getByRole("button", { name: /Quick view/ }).click();
          await expect(page.getByRole("dialog", { name: /Quick view/ })).toBeVisible();
          await expect(page.getByTestId("quick-view").getByTestId("quick-add-btn")).toBeEnabled();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(800);
        await expect.poll(() => page.locator("img").evaluateAll(images => images.filter(image => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && (!image.complete || !image.naturalWidth);
        }).length), { timeout: 60000 }).toBe(0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        expect(overflow, `${screen} horizontal overflow at ${width}px`).toBe(false);
        expect(errors, `${screen} browser errors`).toEqual([]);
        const file = "round4-" + `${screen}-${width}px-${colorScheme}.png`;
        await page.screenshot({ path: resolve(output, file), fullPage: !screen.startsWith("home-") && screen !== "quick-view", animations: "disabled" });
        checks.push({ screen, width, colorScheme, file, overflow, errors });
        await page.close();
      }
    } finally { await context.close(); }
  }
  const motionContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "no-preference", recordVideo: { dir: resolve(output, "round4-motion"), size: { width: 1440, height: 1000 } } });
  try {
    const page = await motionContext.newPage();
    await page.goto(scopedURL("/"), { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    for (const frame of [0, 1, 2, 3]) {
      await page.screenshot({ path: resolve(output, `round4-hero-transition-${frame}.png`) });
      await page.waitForTimeout(160);
    }
    await page.evaluate(() => scrollTo(0, 0));
    for (let step = 0; step < 16; step++) {
      await page.mouse.wheel(0, 180);
      await page.waitForTimeout(180);
    }
    await page.waitForTimeout(600);
    const card = page.getByTestId("listing-card").first();
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    for (const [frame, point] of [[0, [.2, .2]], [1, [.8, .3]], [2, [.7, .8]]]) {
      await page.mouse.move(box.x + box.width * point[0], box.y + box.height * point[1]);
      await page.waitForTimeout(320);
      await page.screenshot({ path: resolve(output, `round4-hover-tilt-${frame}.png`) });
    }
    await page.close();
  } finally { await motionContext.close(); }
  await writeFile(resolve(output, "round4-checks.json"), JSON.stringify(checks, null, 2) + "\n");
} finally { await browser.close(); }

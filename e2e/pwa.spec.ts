import { test, expect, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "3000";
const BASE = `http://mama-ngozi.localhost:${PORT}`;

test.use({ serviceWorkers: "allow" });

test.describe("PWA first (#563)", () => {
  test("the storefront manifest carries the store's name, colour and PNG icons", async ({ page, request }) => {
    await page.goto(`${BASE}/`);
    expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.webmanifest");
    expect(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute("content")).toBe("Mama Ngozi");

    const res = await request.get(`${BASE}/manifest.webmanifest`);
    expect(res.headers()["content-type"]).toContain("application/manifest+json");
    const manifest = await res.json();
    expect(manifest).toMatchObject({ name: "Mama Ngozi African Market", display: "standalone", scope: "/", start_url: "/" });
    for (const icon of manifest.icons as Array<{ src: string; type: string }>) {
      expect(icon.type).toBe("image/png");
      const png = await request.get(`${BASE}${icon.src}`);
      expect(png.status()).toBe(200);
      expect(png.headers()["content-type"]).toBe("image/png");
    }
  });

  test("the store-admin manifest is scoped to /store-admin", async ({ page, request }) => {
    await page.goto(`${BASE}/store-admin/sign-in`);
    expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/store-admin/manifest.webmanifest");
    const manifest = await (await request.get(`${BASE}/store-admin/manifest.webmanifest`)).json();
    expect(manifest).toMatchObject({ scope: "/store-admin", start_url: "/store-admin", display: "standalone" });
    expect(manifest.name).toBe("Mama Ngozi African Market Admin");
  });

  for (const path of ["/", "/store-admin/sign-in"]) {
    test(`Chrome finds ${path} installable`, async ({ page }) => {
      await page.goto(`${BASE}${path}`);
      await page.evaluate(() => navigator.serviceWorker.ready);
      const cdp = await page.context().newCDPSession(page);
      const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
      expect(installabilityErrors).toEqual([]);
    });
  }

  test("offline, a page navigation shows the offline page", async ({ page, context }) => {
    await page.goto(`${BASE}/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await context.setOffline(true);
    await page.goto(`${BASE}/cart`).catch(() => undefined);
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    await context.setOffline(false);
  });

  test.describe("on iPhone", () => {
    const { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } = devices["iPhone 13"];
    test.use({ userAgent, viewport, deviceScaleFactor, isMobile, hasTouch });

    test("after a first order, a one-time Add to Home Screen sheet shows; closing it is remembered", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("pwa:ordered", "1"));
      await page.goto(`${BASE}/`);
      const sheet = page.getByRole("dialog", { name: "Add Mama Ngozi African Market to your Home Screen" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("Add to Home Screen", { exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: "Got it" }).click();
      await expect(sheet).toBeHidden();
      await page.reload();
      await page.waitForTimeout(2000);
      await expect(sheet).toBeHidden();
    });

    test("a first visit with no order shows no sheet", async ({ page }) => {
      await page.goto(`${BASE}/`);
      await page.waitForTimeout(2000);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  });
});

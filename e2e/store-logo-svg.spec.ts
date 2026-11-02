import { test, expect } from "@playwright/test";

const BASE = `http://mama-ngozi.localhost:${process.env.E2E_PORT ?? "3000"}`;
const XSS_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>document.title='xss'</script><rect width="100" height="100" fill="red"/></svg>`;

test.describe("Store logo SVG safety (#60)", () => {
  test("SVG logo renders as a plain img, not via the image optimizer", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const logo = page.locator("img.sf-logo").first();
    await expect(logo).toBeVisible();
    expect(await logo.getAttribute("src")).toMatch(/\.svg$/);
    await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test("an SVG with an embedded script cannot execute as a logo", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/logos/mama-ngozi-logo.svg", (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: XSS_SVG }),
    );
    await page.goto(`${BASE}/`);
    const logo = page.locator("img.sf-logo").first();
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await page.title()).not.toBe("xss");
    expect(errors).toEqual([]);
  });

  test("the image optimizer rejects SVG", async ({ request }) => {
    const res = await request.get(`http://localhost:${process.env.E2E_PORT ?? "3000"}/_next/image?url=%2Flogos%2Fmama-ngozi-logo.svg&w=48&q=75`);
    expect(res.status()).toBe(400);
  });
});

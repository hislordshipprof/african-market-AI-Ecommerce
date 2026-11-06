import { expect, test, chromium } from "@playwright/test";

const port = process.env.E2E_PORT || "3200";

function violationsOf(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

async function watch(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const target = window as unknown as { __csp?: string[] };
    target.__csp = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      target.__csp?.push(event.violatedDirective);
    });
  });
}

test("storefront, admin sign-in, checkout, api and static carry headers with zero CSP violations", async ({ page, request }) => {
  await watch(page);
  const paths = ["/?store=mama-ngozi", "/admin/sign-in", "/checkout?store=mama-ngozi", "/api/health"];
  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBeLessThan(500);
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"], path).toBe("frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    expect(headers["content-security-policy-report-only"], path).toContain("default-src 'self'");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["strict-transport-security"], path).toBe("max-age=63072000");
    expect(headers["content-security-policy-report-only"], path).not.toContain("unsafe-eval");
  }
  expect(await violationsOf(page)).toEqual([]);

  const home = await request.get("/?store=mama-ngozi");
  const html = await home.text();
  const asset = html.match(/\/_next\/static\/[^"']+/)?.[0];
  expect(asset).toBeTruthy();
  const assetResponse = await request.get(asset!);
  expect(assetResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(assetResponse.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
});

test("non-platform host (chromium --host-resolver-rules) loads with zero violations", async () => {
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP mama-ngozi.example.test 127.0.0.1"],
  });
  const page = await browser.newPage();
  await watch(page);
  const response = await page.goto(`http://mama-ngozi.example.test:${port}/`);
  expect(response?.status()).toBeLessThan(500);
  expect(response?.headers()["content-security-policy-report-only"]).toContain("'self'");
  expect(await violationsOf(page)).toEqual([]);
  await browser.close();
});

import { expect, test, chromium } from "@playwright/test";

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
  const paths = ["/?store=mama-ngozi", "/store-admin/sign-in?store=mama-ngozi", "/checkout?store=mama-ngozi", "/api/health"];
  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    if (path.startsWith("/store-admin")) {
      await expect(page.getByText("Sign in to manage your store")).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    }
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"], path).toContain("default-src 'self'");
    expect(headers["content-security-policy"], path).toContain("report-uri /api/csp-report");
    expect(headers["content-security-policy-report-only"], path).toContain("report-uri /api/csp-report");
    expect(headers["permissions-policy"], path).toBe('camera=(), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com")');
    expect(headers["x-powered-by"], path).toBeUndefined();
    expect(headers["content-security-policy-report-only"], path).toContain("default-src 'self'");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["strict-transport-security"], path).toBe("max-age=63072000; includeSubDomains");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["content-security-policy-report-only"], path).not.toContain("unsafe-eval");
    if (!path.startsWith("/api/")) {
      expect(await violationsOf(page), path).toEqual([]);
    }
  }

  const redirect = await request.get("/?store=mama-ngozi", { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(redirect.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(redirect.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(redirect.headers()["x-frame-options"]).toBe("DENY");

  const home = await request.get("/?store=mama-ngozi");
  const html = await home.text();
  const asset = html.match(/\/_next\/static\/[^"']+/)?.[0];
  expect(asset).toBeTruthy();
  const assetResponse = await request.get(asset!);
  expect(assetResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(assetResponse.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
});

test("non-platform host (chromium --host-resolver-rules) loads with zero violations", async ({ baseURL }) => {
  const port = new URL(baseURL!).port;
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP mama-ngozi.example.test 127.0.0.1"],
  });
  const page = await browser.newPage();
  await watch(page);
  const response = await page.goto(`http://mama-ngozi.example.test:${port}/`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("button", { name: /in basket$|^Basket$/ })).toBeVisible();
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response?.headers()["content-security-policy-report-only"]).toContain("'self'");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
  expect(await violationsOf(page)).toEqual([]);
  await browser.close();
});

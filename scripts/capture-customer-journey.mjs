import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Start the app separately with E2E_STORE_OVERRIDE=1 and NEXT_PUBLIC_DEMO_FLOWS=1.
// Every order/profile/address below is created through the rendered demo UI.
const baseURL = process.env.STOREFRONT_URL || "http://localhost:3000";
const output = resolve("screenshots/redesign");
const checks = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const storeURL = (path) => {
  const url = new URL(path, baseURL);
  url.searchParams.set("store", "mama-ngozi");
  return url.href;
};

try {
  for (const width of [390, 1440]) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
        colorScheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // The existing proxy consumes ?store= and persists its scoped cookie.
      // Leave its redirect intact; adding the parameter again would loop.
      async function go(path) {
        await page.goto(storeURL(path), { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("store-name")).toHaveText(
          "Mama Ngozi African Market",
        );
      }
      async function follow(link) {
        await expect(link).toBeVisible();
        const href = await link.getAttribute("href");
        expect(href).toBeTruthy();
        await go(href);
      }
      async function capture(screen, { dialog = false } = {}) {
        await page.evaluate(async () => {
          await document.fonts.ready;
          for (
            let top = 0;
            top < document.body.scrollHeight;
            top += innerHeight
          ) {
            scrollTo(0, top);
            await new Promise((done) => setTimeout(done, 60));
          }
          scrollTo(0, 0);
        });
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
                        !image.currentSrc.includes("wikimedia") &&
                        (!image.complete || !image.naturalWidth),
                    ).length,
                ),
            { timeout: 60000 },
          )
          .toBe(0);
        const metrics = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          fontsReady: document.fonts.status === "loaded",
          imageCount: document.images.length,
          viewport: { width: innerWidth, height: innerHeight },
        }));
        expect(
          metrics.overflow,
          `${screen}: horizontal overflow at ${width}px`,
        ).toBe(false);
        expect(metrics.fontsReady, `${screen}: fonts loaded`).toBe(true);
        expect(errors, `${screen}: browser runtime errors`).toEqual([]);
        const file = `phase2-${screen}-${width}px-${colorScheme}.png`;
        await page.screenshot({
          path: resolve(output, file),
          fullPage: !dialog,
          animations: "disabled",
        });
        checks.push({
          screen,
          width,
          colorScheme,
          file,
          url: page.url(),
          ...metrics,
          errors: [...errors],
        });
        await writeFile(
          resolve(output, "phase2-checks.json"),
          JSON.stringify(checks, null, 2) + "\n",
        );
        console.log(file);
      }
      try {
        await go("/search?q=garri");
        const garri = page
          .getByTestId("listing-card")
          .filter({
            has: page.getByRole("link", { name: "White Garri", exact: true }),
          })
          .first();
        await garri.getByTestId("quick-add-btn").click();
        for (let quantity = 1; quantity < 10; quantity++)
          await garri.getByTestId("stepper-plus").click();
        await expect(garri.getByTestId("stepper-qty")).toHaveText("10");
        await go("/cart");
        await expect(
          page.getByRole("heading", { name: "Your basket", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: /Replace with.*Exact item only/ })
          .click();
        await page
          .getByRole("button", { name: "Let the store suggest a swap" })
          .click();
        await capture("cart");

        await go("/checkout");
        await page.getByLabel("Full name", { exact: true }).fill("Ada Okafor");
        await page
          .getByLabel("Phone number (required)", { exact: true })
          .fill("2025550142");
        await page
          .getByLabel("Email (optional)", { exact: true })
          .fill("ada@example.test");
        await page
          .getByLabel("Order notes (optional)", { exact: true })
          .fill("Please call when my groceries are ready.");
        await expect(
          page.getByRole("button", { name: /Place demo order/ }),
        ).toBeEnabled();
        await capture("checkout");
        await page.getByLabel("Demo outcome").selectOption("declined");
        await page.getByRole("button", { name: /Place demo order/ }).click();
        await expect(page.getByRole("alert").filter({ hasText: /declined|review/i })).toBeVisible();
        await capture("payment-declined");
        await page.getByLabel("Demo outcome").selectOption("success");
        await page.getByRole("button", { name: /Place demo order/ }).click();
        await page.waitForURL(/\/order\/[^/?]+\?.*placed=1/);
        await go(page.url());
        await expect(
          page.getByRole("heading", { name: "You're all set.", exact: true }),
        ).toBeVisible();
        const token = new URL(page.url()).pathname.split("/")[2];
        expect(token).toMatch(/^[a-f\d-]{36}$/i);
        await capture("confirmation");
        await follow(
          page.getByRole("link", { name: "Track order", exact: true }),
        );
        await capture("tracking");
        await page
          .getByRole("button", { name: "Demo: advance order", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Store accepted", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Demo: advance order", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Swap", exact: true }),
        ).toBeVisible();
        const substitutions = page
          .getByRole("link", { name: /substitutions/i })
          .first();
        await follow(substitutions);
        await expect(
          page.getByRole("heading", {
            name: "Your substitutions",
            exact: true,
          }),
        ).toBeVisible();
        await capture("substitutions");
        await page.getByRole("button", { name: "Swap", exact: true }).click();
        await expect(page.getByRole("status")).toContainText("Swap accepted");
        await follow(
          page.getByRole("link", { name: "Back to order", exact: true }),
        );
        for (let step = 0; step < 6; step++) {
          if (
            await page
              .getByRole("heading", { name: "Completed", exact: true })
              .isVisible()
          )
            break;
          await page
            .getByRole("button", { name: "Demo: advance order", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "Updating", exact: false }),
          ).toHaveCount(0);
        }
        await expect(
          page.getByRole("heading", { name: "Completed", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Message the store", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: /Message Mama Ngozi/ }),
        ).toBeVisible();
        await page
          .getByLabel("Your message", { exact: true })
          .fill("Thanks for packing everything carefully.");
        await page
          .getByRole("button", { name: "Preview message", exact: true })
          .click();
        await capture("chat", { dialog: true });
        await page.keyboard.press("Escape");
        await follow(
          page.getByRole("link", { name: "Report an issue", exact: true }),
        );
        await page.getByRole("checkbox").first().check();
        await page
          .getByLabel("Describe the issue", { exact: true })
          .fill(
            "The packaging arrived damaged. Please review this demo report.",
          );
        await page
          .getByLabel("Issue type", { exact: true })
          .selectOption("damaged");
        await capture("report");

        await go("/account/sign-in");
        await page
          .getByLabel("Phone number", { exact: true })
          .fill("2025550142");
        await capture("sign-in");
        await page
          .getByRole("button", { name: "Get demo code", exact: true })
          .click();
        await expect(page.getByLabel("Verification code")).toBeVisible();
        await capture("sign-in-code");
        await page.getByLabel("Verification code").fill("123456");
        await page
          .getByRole("button", { name: "Verify and continue", exact: true })
          .click();
        await page.waitForURL(/\/account(?:\?|$)/);
        await go("/account");
        await page.getByLabel("Name", { exact: true }).fill("Ada Okafor");
        await page
          .getByLabel("Email", { exact: true })
          .fill("ada@example.test");
        await page
          .getByRole("button", { name: "Save details", exact: true })
          .click();
        await page
          .getByLabel("Add a demo address", { exact: true })
          .fill("42 Market Lane");
        await page
          .getByRole("button", { name: "Look up demo address", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: /42 Market Lane.*Save this simulated address/,
          })
          .click();
        await expect(
          page.getByText("No saved addresses yet.", { exact: true }),
        ).toHaveCount(0);
        await capture("account");
        await follow(page.locator("a.sf-account-order").first());
        await expect(
          page.getByRole("heading", { name: "Completed", exact: true }),
        ).toBeVisible();
        await capture("account-order");
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

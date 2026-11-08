import { storeUrl, E2E_PORT } from "./urls";
import { test, expect } from "@playwright/test";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";
import { deleteGuestOrder, insertGuestOrder } from "./order-fixture";

const base = storeUrl("mama-ngozi");
const apiBase = `http://localhost:${E2E_PORT}`;
const email = `e2e-customer-${Date.now()}@test.example`;

test.describe("Customer magic-link auth", () => {
  test("sign in via magic link → /account → sign out", async ({ page, request }) => {
    // 1. Sign up the test user (sign-up/email is not a customer-only path, no slug needed)
    const signupRes = await request.post(
      `${apiBase}/api/auth/sign-up/email`,
      {
        data: { email, password: "E2eTestPass-123!", name: "E2E Customer" },
      },
    );
    expect(
      signupRes.ok(),
      `Sign-up failed ${signupRes.status()}: ${await signupRes.text()}`,
    ).toBe(true);

    // 2. Navigate to the store sign-in page and submit via UI (browser resolves subdomain)
    await page.goto(`${base}/account/sign-in`);
    await expect(page.locator("[data-slot='card-title']")).toContainText("Sign in");

    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();

    // 3. Wait for "Check your email" screen
    await expect(
      page.locator("[data-slot='card-title']"),
    ).toContainText("Check your email", { timeout: 10000 });

    // 4. Retrieve the magic-link token from the test-only API (no slug needed)
    const tokenRes = await request.get(
      `${apiBase}/api/e2e/magic-link-token?email=${encodeURIComponent(email)}`,
    );
    const tokenBody = await tokenRes.json();
    if (!tokenRes.ok()) {
      throw new Error(
        `Token API failed ${tokenRes.status()}: ${JSON.stringify(tokenBody)}`,
      );
    }
    const { token } = tokenBody;
    expect(token).toBeTruthy();

    // 5. Visit the verification URL on the store subdomain
    const verifyUrl = `${base}/api/auth/magic-link/verify?token=${token}&callbackURL=/account`;
    await page.goto(verifyUrl);

    // 6. Should land on the account page
    await page.waitForLoadState("networkidle", { timeout: 20000 });
    await expect(
      page.getByRole("heading", { name: "Your account" }),
    ).toBeVisible({ timeout: 15000 });

    // 7. Verify profile shows the user's name
    const nameInput = page.locator("input[autocomplete='name']");
    await expect(nameInput).toHaveValue("E2E Customer", { timeout: 5000 });

    await expect(page.getByTestId("store-name")).toHaveText("Mama Ngozi African Market");
    await expect(page.getByText("Mama Ngozi African Market").first()).toBeVisible();

    // 8. Click sign out
    await page.getByRole("button", { name: "Sign out" }).click();

    // 9. Should redirect to sign-in and the session is gone
    await page.waitForURL("**/account/sign-in", { timeout: 10000 });
    const sessionBody = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session", { credentials: "include" });
      return res.json();
    });
    expect(sessionBody?.session ?? null).toBeNull();
  });

  test("a returning guest who signs in by magic link sees their past order in order history", async ({ page, request }) => {
    const guestEmail = `e2e-returning-guest-${Date.now()}@test.example`;
    const seeded = await insertGuestOrder({
      email: guestEmail,
      name: "Returning Guest",
      phone: "+15550007070",
    });
    try {
      await page.goto(`${base}/account/sign-in`);
      await page.getByLabel("Email address").fill(guestEmail);
      await page.getByRole("button", { name: "Send sign-in link" }).click();
      await expect(page.locator("[data-slot='card-title']")).toContainText("Check your email", { timeout: 10000 });

      const tokenRes = await request.get(
        `${apiBase}/api/e2e/magic-link-token?email=${encodeURIComponent(guestEmail)}`,
      );
      expect(tokenRes.ok()).toBe(true);
      const { token } = await tokenRes.json();
      await page.goto(`${base}/api/auth/magic-link/verify?token=${token}&callbackURL=/account`);

      const row = page.getByRole("link", { name: new RegExp(`Order #${seeded.number}\\b`) });
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(row).toHaveAttribute("href", `/order/${seeded.orderId}`);
      await expect(row).toContainText("$12.50");
    } finally {
      await deleteGuestOrder(seeded);
    }
  });

  test("signed-out header opens sign-in for this store", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/account\/sign-in$/);
    await expect(page.getByTestId("store-name")).toHaveText("Mama Ngozi African Market");
    await expect(page.getByText("Sign in to Mama Ngozi African Market")).toBeVisible();
  });

  test("an expired link offers a new sign-in", async ({ page }) => {
    await page.goto(`${base}/account?error=INVALID_TOKEN`);
    await expect(page).toHaveURL(/\/account\/sign-in\?error=INVALID_TOKEN/);
    await expect(
      page.getByRole("alert").filter({ hasText: "expired" }),
    ).toContainText("This link has expired. Send a new one.");
  });
});

test("signed-out production account redirects with demo flows disabled", async ({ page }) => {
  test.setTimeout(240_000);

  async function boot(env: Record<string, string>) {
    const port = await reservePort(laneSmokePort());
    const running = await startSpawnedServer({
      command: `pnpm exec next start -p ${port}`,
      shell: true,
      cwd: process.cwd(),
      port,
      env: {
        ...process.env,
        CI: "",
        E2E_STORE_OVERRIDE: "",
        E2E_FAKE_STRIPE: "",
        NODE_ENV: "production",
        ...env,
      },
      healthUrl: `http://127.0.0.1:${port}/api/health`,
      healthOk: (status) => status === 200 || status === 503,
    });
    return { running, origin: `http://mama-ngozi.localhost:${port}` };
  }

  async function expectRealSignIn(origin: string) {
    await page.goto(`${origin}/account`);
    await expect(page).toHaveURL(/\/account\/sign-in$/);
    await expect(page.getByText("Explore the demo.")).toHaveCount(0);
    await expect(page.getByText("demo code")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeVisible();
    await expect(page.getByText("Sign in to Mama Ngozi African Market")).toBeVisible();
  }

  const productionOverride = await boot({
    VERCEL: "1",
    VERCEL_ENV: "production",
    NEXT_PUBLIC_DEMO_FLOWS: "1",
  });
  try {
    await expectRealSignIn(productionOverride.origin);
  } finally {
    await productionOverride.running.stop();
  }

  const unflagged = await boot({
    VERCEL: "1",
    VERCEL_ENV: "",
    NEXT_PUBLIC_DEMO_FLOWS: "",
  });
  try {
    await expectRealSignIn(unflagged.origin);
  } finally {
    await unflagged.running.stop();
  }
});

test.describe("sign-in reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the poster stays still", async ({ page }) => {
    await page.goto(`${base}/account/sign-in`);
    const poster = page.getByTestId("story-poster");
    await expect(poster).toBeVisible();
    await page.waitForTimeout(400);
    const first = await poster.evaluate((el) => getComputedStyle(el).transform);
    await page.waitForTimeout(1500);
    const second = await poster.evaluate((el) => getComputedStyle(el).transform);
    expect(second).toBe(first);
  });
});

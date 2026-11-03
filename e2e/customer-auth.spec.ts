import { storeUrl, E2E_PORT } from "./urls";
import { test, expect } from "@playwright/test";

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

    // 8. Click sign out
    await page.getByRole("button", { name: "Sign out" }).click();

    // 9. Should redirect to sign-in
    await page.waitForURL("**/account/sign-in", { timeout: 10000 });
  });
});

import { storeUrl, E2E_PORT } from "./urls";
import { test, expect } from "@playwright/test";

const base = storeUrl("mama-ngozi");
const apiBase = `http://localhost:${E2E_PORT}`;

test.describe("Customer address book", () => {
  test("signed-in customer saves, edits, and removes an address", async ({ page, request }) => {
    const email = `e2e-address-${Date.now()}@test.example`;
    const signupRes = await request.post(`${apiBase}/api/auth/sign-up/email`, {
      data: { email, password: "E2eTestPass-123!", name: "Ada Address" },
    });
    expect(signupRes.ok(), await signupRes.text()).toBe(true);

    await page.goto(`${base}/account/sign-in`);
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect(page.locator("[data-slot='card-title']")).toContainText("Check your email", { timeout: 10000 });

    const tokenRes = await request.get(
      `${apiBase}/api/e2e/magic-link-token?email=${encodeURIComponent(email)}`,
    );
    const tokenBody = await tokenRes.json();
    expect(tokenRes.ok(), JSON.stringify(tokenBody)).toBe(true);

    await page.goto(`${base}/api/auth/magic-link/verify?token=${tokenBody.token}&callbackURL=/account`);
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Explore the demo.")).toHaveCount(0);
    await expect(page.getByText("No saved addresses yet.")).toBeVisible();
    await expect(page.getByText("No saved cards yet.")).toBeVisible();

    const form = page.getByTestId("account-address-form");
    await form.getByLabel("Label").fill("Home <script>alert(1)</script>");
    await form.getByLabel("Street").fill("1 Market St");
    await form.getByLabel("City").fill("Silver Spring");
    await form.getByLabel("State").selectOption("MD");
    await form.getByLabel("ZIP").fill("20910");
    await form.getByRole("button", { name: "Add address" }).click();

    const list = page.getByTestId("account-address-list");
    await expect(list.getByText("Home <script>alert(1)</script>")).toBeVisible();
    await expect(list.getByText("Default")).toBeVisible();
    await expect(page.locator("script", { hasText: "alert(1)" })).toHaveCount(0);

    await form.getByLabel("Label").fill("Work");
    await form.getByLabel("Street").fill("2 Market St");
    await form.getByLabel("City").fill("Silver Spring");
    await form.getByLabel("ZIP").fill("20910");
    await form.getByRole("button", { name: "Add address" }).click();
    await expect(list.getByText("Work")).toBeVisible();

    const work = list.locator("article", { hasText: "Work" });
    await work.getByRole("button", { name: "Set as default" }).click();
    await expect(work.getByText("Default")).toBeVisible();

    await list.locator("article", { hasText: "Home" }).getByRole("button", { name: "Remove" }).click();
    await expect(list.getByText("Home <script>alert(1)</script>")).toHaveCount(0);
    await expect(work.getByText("Default")).toBeVisible();

    await page.getByLabel("Phone").fill("(301) 555-0100");
    await page.getByRole("button", { name: "Save phone" }).click();
    await expect(page.getByText("Phone saved.")).toBeVisible();
  });
});

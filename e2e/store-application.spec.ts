import { mkdirSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";
import { generateTOTP } from "./totp";

const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [["1280px", { width: 1280, height: 1000 }], ["390px", { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/554-${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 1000 });
}

async function apply(page: Page, root: string, name: string, email: string, phone: string) {
  await page.goto(`${root}/sell`);
  await page.getByLabel("Store name").fill(name);
  await page.getByLabel("Kind of store").selectOption("african");
  await page.getByLabel("Street address").fill("2100 Bissonnet St");
  await page.getByLabel("City").fill("Houston");
  await page.getByLabel("State").selectOption("TX");
  await page.getByLabel("ZIP").fill("77005");
  await page.getByLabel("Your name").fill("Ada Obi");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Phone").fill(phone);
  await page.getByLabel("Website or social page").fill("instagram.com/adasmarket");
  await page.getByLabel("Pickup at the store").check();
  await page.getByRole("button", { name: "Send application" }).click();
  await expect(page.getByRole("heading", { name: "Thanks, we have your application" })).toBeVisible();
}

// /sell lives on the root domain, so this boots a server with PLATFORM_ROOT_DOMAIN=localhost (#554).
test("a store applies on /sell; a platform admin approves one into a setup store and rejects another", async ({ page }) => {
  test.setTimeout(240_000);
  const port = await reservePort(laneSmokePort());
  const root = `http://localhost:${port}`;
  const running = await startSpawnedServer({
    command: `pnpm exec next start -p ${port}`,
    shell: true,
    cwd: process.cwd(),
    port,
    env: {
      ...process.env,
      CI: "true",
      VERCEL: "",
      VERCEL_ENV: "",
      E2E_STORE_OVERRIDE: "",
      STRIPE_SECRET_KEY: "",
      PLATFORM_ROOT_DOMAIN: "localhost",
      BETTER_AUTH_URL: root,
      BETTER_AUTH_TRUSTED_ORIGINS: root,
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  const run = Date.now().toString(36);
  const digits = String(Date.now()).slice(-7);
  // A fresh client address per run, so reruns within the hour stay under the 5-an-hour limit.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `203.0.113.${Number(digits.slice(-2)) + 1}-${run}` });
  const approveName = `E2E Approve Market ${run}`;
  const rejectName = `E2E Reject Market ${run}`;
  try {
    // A store's own host has no application form.
    const storeHost = await page.goto(`http://mama-ngozi.localhost:${port}/sell`);
    expect(storeHost?.status()).toBe(404);

    await page.goto(`${root}/`);
    await page.getByRole("banner").getByRole("link", { name: "Sell on African Markets" }).click();
    await expect(page).toHaveURL(`${root}/sell`);
    await expect(page.getByRole("heading", { level: 1, name: "Sell on African Markets" })).toBeVisible();
    await shoot(page, "sell-form");

    await page.getByRole("button", { name: "Send application" }).click();
    // Native required fields stop an empty form before it is sent.
    await expect(page.getByLabel("Store name")).toBeFocused();

    await apply(page, root, approveName, `approve-${run}@example.com`, `713555${digits.slice(-4)}`);
    await shoot(page, "sell-thanks");
    await apply(page, root, rejectName, `reject-${run}@example.com`, `832555${digits.slice(-4)}`);

    await page.setExtraHTTPHeaders({});
    await page.goto(`${root}/admin/sign-in`);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.click("button[type='submit']");
    await page.getByLabel("Verification code").fill(generateTOTP(TOTP_SECRET));
    await page.click("button[type='submit']");
    await page.waitForURL("**/admin", { timeout: 15_000 });

    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Applications" }).first().click();
    await expect(page).toHaveURL(`${root}/admin/applications`);
    await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();

    const approveCard = page.getByRole("article", { name: approveName });
    await expect(approveCard.getByText("Pickup", { exact: true })).toBeVisible();
    await expect(approveCard.getByRole("link", { name: "https://instagram.com/adasmarket" })).toBeVisible();
    await shoot(page, "admin-applications");

    const slug = `e2e-approve-${run}`;
    await approveCard.getByLabel("Store address").fill(slug);
    await approveCard.getByRole("button", { name: "Approve" }).click();
    const outcome = page.getByRole("status").filter({ hasText: `${approveName} approved.` });
    await expect(outcome).toContainText("The owner invite is on its way.");
    await expect(page.getByRole("article", { name: approveName })).toHaveCount(0);
    await shoot(page, "admin-approved");

    const rejectCard = page.getByRole("article", { name: rejectName });
    await rejectCard.getByText("Reject…").click();
    await rejectCard.getByLabel(/Reason/).fill("Outside the pilot metros for now");
    await rejectCard.getByRole("button", { name: "Reject and email the applicant" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${rejectName} rejected.` })).toContainText("without your reason");
    await expect(page.getByRole("listitem").filter({ hasText: rejectName })).toContainText("Outside the pilot metros for now");

    await page.getByRole("listitem").filter({ hasText: approveName }).getByRole("link", { name: "Open store" }).click();
    await expect(page.getByLabel("Slug")).toHaveValue(slug);
    await expect(page.getByTestId("store-status")).toContainText("Setup");
  } finally {
    await running.stop();
  }
});

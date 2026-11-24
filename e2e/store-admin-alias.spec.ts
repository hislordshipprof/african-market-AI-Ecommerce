import { mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ALIAS, ALIAS_LAUNCH, serveVercelHostsFrom, startAliasServer } from "./vercel-hosts";
import { deleteUser, insertStoreOwner, latestResetToken } from "./account-fixture";
import { inboxOrderId } from "./order-fixture";
import { generateTOTP } from "./totp";

// #797: on production's single vercel.app address the store lives in a cookie, so store admin's sign-in, sign-out
// and password reset must keep it.
const SHOTS = process.env.PROOF_DIR ?? "screenshots";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const STORE = "Mama Ngozi African Market";

test.use(ALIAS_LAUNCH);
test.describe.configure({ mode: "serial" });

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, size, scheme] of [["1280-light", { width: 1280, height: 1000 }, "light"], ["390-dark", { width: 390, height: 844 }, "dark"]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/797-${name}-${label}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 1000 });
}

async function remembered(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies(`https://${ALIAS}`)).find((c) => c.name === "store_override")?.value;
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").fill(generateTOTP(TOTP_SECRET));
  await page.click("button[type='submit']");
}

async function aliasPage(browser: Browser, port: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await serveVercelHostsFrom(context, port);
  return { context, page: await context.newPage() };
}

test("store admin on the production alias: sign-in, sign-out, the new-order link and password reset keep the store", async ({ browser }) => {
  test.setTimeout(300_000);
  const authSecret = randomBytes(32).toString("base64");
  const email = `alias-owner-${randomBytes(4).toString("hex")}@mama-ngozi.test`;
  const password = "AliasOwner-797!";
  const newPassword = "AliasOwner-797-new!";
  const userId = await insertStoreOwner({ email, password, authSecret, totpSecret: TOTP_SECRET });
  const orderId = await inboxOrderId(1001);
  const running = await startAliasServer(authSecret);
  try {
    const { context, page } = await aliasPage(browser, running.port);
    const prefetches: string[] = [];
    page.on("request", (request) => {
      const headers = request.headers();
      if (headers["next-router-prefetch"] === "1") prefetches.push(new URL(request.url()).pathname);
    });

    // Sign-in: the store moves from ?store= into the cookie, and the prefetched reset link must not clear it.
    await page.goto(`https://${ALIAS}/store-admin/sign-in?store=mama-ngozi`);
    await expect(page).toHaveURL(`https://${ALIAS}/store-admin/sign-in`);
    const forgot = page.getByRole("link", { name: "Forgot password?" });
    await forgot.hover();
    await expect.poll(() => prefetches.includes("/admin/reset-password")).toBe(true);
    await page.waitForLoadState("networkidle");
    expect(await remembered(context)).toBe("mama-ngozi");
    await shoot(page, "sign-in");
    await signIn(page, email, password);
    await expect(page).toHaveURL(`https://${ALIAS}/store-admin`);
    await expect(page.getByText(STORE).first()).toBeVisible();
    await expect(page.getByText("Store not found")).toHaveCount(0);
    await shoot(page, "dashboard");

    // Sign-out returns to the store's sign-in, and a later visit still finds the store.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`https://${ALIAS}/store-admin/sign-in`);
    expect(await remembered(context)).toBe("mama-ngozi");
    await page.goto(`https://${ALIAS}/store-admin`);
    await expect(page).toHaveURL(`https://${ALIAS}/store-admin/sign-in`);
    await expect(page.getByText("Sign in to manage your store")).toBeVisible();

    // The new-order email link (#785), opened signed out: sign-in first, then that order.
    await page.goto(`https://${ALIAS}/store-admin/orders?store=mama-ngozi&order=${orderId}`);
    await expect(page).toHaveURL(/\/store-admin\/sign-in\?next=/);
    await signIn(page, email, password);
    await expect(page).toHaveURL(`https://${ALIAS}/store-admin/orders?order=${orderId}`);
    await expect(page.getByText("Order #1001").first()).toBeVisible();
    await page.getByRole("link", { name: "Back to dashboard" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`https://${ALIAS}/store-admin/sign-in`);

    // Password reset started from store admin.
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    expect(await remembered(context)).toBe("mama-ngozi");
    await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/store-admin/sign-in?store=mama-ngozi");
    await shoot(page, "reset");
    const requested = page.waitForRequest((r) => r.url().endsWith("/api/auth/request-password-reset"));
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    const redirectTo = (await requested).postDataJSON().redirectTo as string;
    await expect(page.getByText(`If ${email} has an account`)).toBeVisible();
    await context.close();

    // The emailed link, opened in a browser that never saw the store, ends at that store's sign-in.
    const fresh = await aliasPage(browser, running.port);
    const token = await latestResetToken(userId);
    await fresh.page.goto(`https://${ALIAS}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(redirectTo)}`);
    await expect(fresh.page.getByLabel("New password")).toBeVisible();
    expect(await remembered(fresh.context)).toBe("mama-ngozi");
    await fresh.page.getByLabel("New password").fill(newPassword);
    await fresh.page.getByRole("button", { name: "Change password" }).click();
    await expect(fresh.page.getByRole("heading", { name: "Password changed" })).toBeVisible();
    await fresh.page.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(fresh.page).toHaveURL(`https://${ALIAS}/store-admin/sign-in`);
    await signIn(fresh.page, email, newPassword);
    await expect(fresh.page).toHaveURL(`https://${ALIAS}/store-admin`);
    await expect(fresh.page.getByText(STORE).first()).toBeVisible();
    await fresh.context.close();
  } finally {
    await running.stop();
    await deleteUser(userId);
  }
});

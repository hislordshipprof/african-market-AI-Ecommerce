import { test, expect, type Page } from "@playwright/test";
import { generateTOTP } from "./totp";
import { deleteE2eListings } from "./cleanup-listings";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const OWNER_EMAIL = "owner@mama-ngozi.test";
const OWNER_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";
const IMPORT_URL = "/store-admin/listings/import?store=mama-ngozi";

async function storeOwnerSignIn(page: Page) {
  await page.goto("/store-admin/sign-in?store=mama-ngozi");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.click("button[type='submit']");
  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });
  await page.getByLabel("Verification code").fill(generateTOTP(SEED_TOTP_SECRET));
  await page.click("button[type='submit']");
  await page.waitForURL(
    (url) => url.pathname.startsWith("/store-admin") && !url.pathname.includes("sign-in"),
    { timeout: 15000 },
  );
}

test.describe("placeholder weight", () => {
  const createdNames: string[] = [];

  test.afterAll(async () => {
    if (createdNames.length > 0) {
      await deleteE2eListings({ names: createdNames });
    }
  });

  test("an imported custom item without a weight shows Needs weight until the owner saves one", async ({ page }) => {
    const name = `E2E Needs Weight ${Date.now()}`;
    createdNames.push(name);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-weight-e2e-"));
    const csvPath = path.join(dir, "import.csv");
    fs.writeFileSync(csvPath, `name,price\n${name},4.50\n`, "utf-8");

    await storeOwnerSignIn(page);
    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");
    await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Import 1 listing" }).click();
    await expect(page.getByRole("heading", { name: "Import Complete" })).toHaveText("Import Complete");
    await expect(page.locator("[data-needs-weight-count]")).toHaveText("1 listing needs a weight.");

    await page.getByRole("button", { name: "Go to Products" }).click();
    await expect(page).toHaveURL(/\/store-admin\/listings/);
    const active = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: "Active listings" }),
    });
    await expect(active.locator("[data-needs-weight]")).toHaveText("Needs weight");

    await page.getByRole("switch", { name: `Deactivate ${name}` }).click();
    const inactive = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: "Inactive listings" }),
    });
    await expect(inactive.locator("[data-needs-weight]")).toHaveText("Needs weight", { timeout: 15000 });
    await expect(active.locator("[data-needs-weight]")).toHaveCount(0);

    await inactive.getByRole("button", { name: `Edit ${name}` }).click();
    const dialog = page.getByRole("dialog", { name: "Edit listing" });
    const weight = dialog.getByLabel("Variant weight in grams");
    await expect(weight).toHaveAttribute("placeholder", "Needs weight");
    await expect(weight).toHaveValue("");
    await weight.fill("22680");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-needs-weight]")).toHaveCount(0);

    await page.getByRole("button", { name: `Edit ${name}` }).click();
    const saved = page.getByRole("dialog", { name: "Edit listing" }).getByLabel("Variant weight in grams");
    await expect(saved).toHaveValue("22680");
    await expect(saved).toHaveAttribute("placeholder", "Weight (g)");
  });
});

import { test, expect } from "@playwright/test";
import { deleteE2eListings } from "./cleanup-listings";
import { storeOwnerSignIn } from "./store-owner-auth";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const IMPORT_URL = "/store-admin/listings/import?store=mama-ngozi";

test.describe("CSV import weight column", () => {
  const createdNames: string[] = [];

  test.afterAll(async () => {
    if (createdNames.length > 0) {
      await deleteE2eListings({ names: createdNames });
    }
  });

  test("a 50 lb bag imported with a weight column shows 22680 in the edit form", async ({ page }) => {
    const name = `E2E Garri 50lb ${Date.now()}`;
    createdNames.push(name);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-weight-e2e-"));
    const csvPath = path.join(dir, "import.csv");
    fs.writeFileSync(csvPath, `name,price,weight\n${name},45.00,50 lb\n`, "utf-8");

    await storeOwnerSignIn(page);
    await page.goto(IMPORT_URL);
    await page.locator("input[type='file']").setInputFiles(csvPath);
    await page.click("text=Upload & Preview");
    await expect(page.getByText(name)).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Import 1 listing" }).click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });

    await page.goto("/store-admin/listings?store=mama-ngozi");
    await expect(page.getByText(name)).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    await expect(page.getByRole("dialog", { name: "Edit listing" })).toBeVisible();
    await expect(page.getByPlaceholder("Weight (g)")).toHaveValue("22680");
  });
});

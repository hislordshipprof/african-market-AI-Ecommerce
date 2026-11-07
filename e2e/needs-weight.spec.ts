import { test, expect } from "@playwright/test";
import { deleteE2eListings } from "./cleanup-listings";
import { storeOwnerSignIn } from "./store-owner-auth";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const IMPORT_URL = "/store-admin/listings/import?store=mama-ngozi";

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
    const section = (title: string) =>
      page.locator("[data-slot=card]").filter({ has: page.getByText(title, { exact: true }) });
    const rowFor = (title: string) =>
      section(title)
        .getByRole("button", { name: `Edit ${name}`, exact: true })
        .locator("xpath=ancestor::div[contains(@class,'flex-wrap')][1]");
    await expect(rowFor("Active listings").locator("[data-needs-weight]")).toHaveText("Needs weight");

    await page.getByRole("switch", { name: `Deactivate ${name}` }).click();
    await expect(rowFor("Inactive listings").locator("[data-needs-weight]")).toHaveText("Needs weight", {
      timeout: 15000,
    });
    await expect(
      section("Active listings").getByRole("button", { name: `Edit ${name}`, exact: true }),
    ).toHaveCount(0);

    await section("Inactive listings").getByRole("button", { name: `Edit ${name}` }).click();
    const dialog = page.getByRole("dialog", { name: "Edit listing" });
    const weight = dialog.getByLabel("Variant weight in grams");
    await expect(weight).toHaveAttribute("placeholder", "Needs weight");
    await expect(weight).toHaveValue("");
    await page.setViewportSize({ width: 390, height: 844 });
    const weightFit = await weight.evaluate((el) => {
      const style = getComputedStyle(el);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return { text: 0, room: 0 };
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const text = ctx.measureText(el.getAttribute("placeholder") ?? "").width;
      const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { text, room };
    });
    expect(weightFit.text).toBeLessThanOrEqual(weightFit.room);
    await weight.fill("22680");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page
        .getByRole("button", { name: `Edit ${name}`, exact: true })
        .locator("xpath=ancestor::div[contains(@class,'flex-wrap')][1]")
        .locator("[data-needs-weight]"),
    ).toHaveCount(0);

    await page.getByRole("button", { name: `Edit ${name}` }).click();
    const saved = page.getByRole("dialog", { name: "Edit listing" }).getByLabel("Variant weight in grams");
    await expect(saved).toHaveValue("22680");
    await expect(saved).toHaveAttribute("placeholder", "Weight (g)");
  });
});

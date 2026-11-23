import { test, expect, type Locator } from "@playwright/test";
import { storeUrl } from "./urls";
import { deleteBatchOrders, insertBatchOrders } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";

// Ofada Rice has no photo in the seed, so every view of it shows the missing-photo placeholder.
const PRODUCT = "Ofada Rice";

function placeholder(scope: Locator) {
  return scope.getByRole("img", { name: `${PRODUCT} - product illustration` });
}

test.describe("#742: one placeholder for a product with no photo", () => {
  test("the quick view, the basket drawer and the pick list show the same placeholder", async ({ page }, testInfo) => {
    await page.goto(`${storeUrl("mama-ngozi")}/categories/grains-and-flours`);
    const card = page.getByTestId("listing-card").filter({ hasText: PRODUCT }).first();
    await card.hover();
    await card.getByRole("button", { name: `Quick view ${PRODUCT}` }).click();
    const quickView = page.getByRole("dialog", { name: /Quick view/ });
    await expect(placeholder(quickView).locator("svg.lucide-wheat")).toBeVisible();
    await quickView.getByRole("button", { name: /^Add/ }).first().click();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /in basket$/ }).click();
    const drawer = page.getByRole("dialog", { name: "Your basket" });
    await expect(placeholder(drawer).locator("svg.lucide-wheat")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: /in basket$/ }).click();
    await expect(placeholder(page.getByRole("dialog", { name: "Your basket" })).locator("svg.lucide-wheat")).toBeVisible();

    const base = 74200 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
    await insertBatchOrders([base, base + 1], ["pickup", "store-delivery"], PRODUCT);
    try {
      await storeOwnerSignIn(page);
      await page.goto("/store-admin/orders?store=mama-ngozi");
      const chooser = page.getByRole("group").filter({ hasText: "Choose 2 to 4 accepted orders" });
      await chooser.getByRole("checkbox", { name: new RegExp(`#${base}\\b`) }).check();
      await chooser.getByRole("checkbox", { name: new RegExp(`#${base + 1}\\b`) }).check();
      await page.getByRole("button", { name: "Pick 2 orders together" }).click();
      await page.waitForURL(/\/store-admin\/orders\/batch\//);
      const line = page.getByTestId("batch-line").filter({ hasText: PRODUCT });
      await expect(placeholder(line).locator("svg.lucide-wheat")).toBeVisible();
    } finally {
      await deleteBatchOrders([base, base + 1]);
    }
  });
});

import { test, expect, type Page } from "@playwright/test";
import { deleteBatchOrders, insertBatchOrders } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";

const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";

async function shoot(page: Page, name: string): Promise<void> {
  const proofDir = process.env.PROOF_DIR;
  if (!proofDir) return;
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [390, 1280]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${proofDir}/${name}-${width}-${scheme}.png`, fullPage: true, animations: "disabled" });
    }
  }
  await hideToasts.evaluate((tag) => tag.parentNode?.removeChild(tag));
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
}

test.describe("Batch picking (#564)", () => {
  test("staff pick two orders together on the phone packing screen, short the newest, ready one, then leave", async ({ page }, testInfo) => {
    const base = 56400 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex * 2;
    const [older, newer] = [base, base + 1];
    await insertBatchOrders([older, newer], ["courier", "pickup"]);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);

      const card = page.getByRole("group").filter({ hasText: "Choose 2 to 4 accepted orders" });
      await card.getByRole("checkbox", { name: new RegExp(`#${older}\\b`) }).check();
      await card.getByRole("checkbox", { name: new RegExp(`#${newer}\\b`) }).check();
      await shoot(page, "inbox-pick-together");
      await page.getByRole("button", { name: "Pick 2 orders together" }).click();
      await page.waitForURL(/\/store-admin\/orders\/batch\//);

      // Bags: the older order is A.
      const totes = page.getByTestId("tote");
      await expect(totes.nth(0)).toContainText(`#${older}`);
      await expect(totes.nth(0)).toContainText("A");
      await expect(totes.nth(1)).toContainText(`#${newer}`);

      // The shared item is one line: ×3 in total, A ×2 and B ×1.
      const shared = page.getByTestId("batch-line").filter({ hasText: "×3" });
      await expect(shared).toHaveCount(1);
      await expect(shared.getByRole("listitem")).toHaveText([new RegExp(`A×2 for #${older}`), new RegExp(`B×1 for #${newer}`)]);
      await expect(page.getByRole("button", { name: /^Picked all/ })).toHaveCount(0);
      await shoot(page, "packing-before-start");

      await page.getByRole("button", { name: "Start packing" }).click();
      await expect(page.getByText("Packing started")).toBeVisible();
      await expect(totes.nth(0)).toContainText("Packing");
      await expect(page.getByRole("button", { name: "Start packing" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Picked all/ }).first()).toBeEnabled();
      await shoot(page, "packing-started");

      // Found 2 of 3: the oldest order is filled, the newest is short and its customer is asked.
      await shared.getByRole("button", { name: "Short" }).click();
      await page.getByLabel("Units found").fill("2");
      await page.getByRole("button", { name: "Mark short" }).click();
      await expect(shared).toContainText(`found 0 of 1, waiting for customer`);
      await expect(totes.nth(1)).toContainText("Waiting for a swap choice");

      // Tick the rest.
      const pickAll = page.getByRole("button", { name: /^Picked all/ });
      for (let left = await pickAll.count(); left > 0; left--) {
        await pickAll.first().click();
        await expect(pickAll).toHaveCount(left - 1);
      }
      await shoot(page, "packing-picked");

      // The older order goes Ready on its own; the newer one waits for its customer.
      await page.getByRole("button", { name: `Mark #${older} ready (bag A)` }).click();
      await expect(page.getByText(`Order #${older} marked ready`)).toBeVisible();
      await expect(totes.nth(0)).toContainText("Ready");
      await expect(page.getByRole("button", { name: `Mark #${newer} ready (bag B)` })).toHaveCount(0);

      // In the inbox the batched order cannot be picked on its own.
      await page.goto(ORDERS_URL);
      // The batch lists only the orders still being packed.
      await expect(page.getByRole("list", { name: "Open batches" })).toContainText(`Batch of #${newer}`);
      await page.locator("button", { hasText: `#${newer}` }).click();
      await expect(page.getByText("This order is in a batch. Pick it from the packing screen.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Pick", exact: true })).toHaveCount(0);
      await shoot(page, "inbox-batched-order");
      await page.getByRole("link", { name: "Open packing screen" }).click();
      await page.waitForURL(/\/store-admin\/orders\/batch\//);

      await page.getByRole("button", { name: "Leave batch" }).click();
      await expect(page.getByText("This batch has ended")).toBeVisible();

      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${newer}` }).click();
      await expect(page.getByText("This order is in a batch")).toHaveCount(0);
      await expect(page.getByText(/Found 0 of 1 · waiting for customer/)).toBeVisible();
    } finally {
      await deleteBatchOrders([older, newer]);
    }
  });
});

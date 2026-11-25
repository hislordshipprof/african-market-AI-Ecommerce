import { test, expect } from "@playwright/test";
import { deleteDriverRouteOrders, insertDriverRouteOrders } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";

// Own-driver route link (#566). Slots far in the future so no other spec's orders share them.
test.describe("Own-driver route link", () => {
  test("the owner texts a slot's Ready orders to a driver, then revokes the link", async ({ page }) => {
    const slot = "2031-06-03T18:00:00.000Z";
    const numbers = [56601, 56602];
    await insertDriverRouteOrders({ numbers, slot });
    try {
      await storeOwnerSignIn(page);
      await page.goto("/store-admin/orders?store=mama-ngozi");
      const panel = page.getByRole("region", { name: "Your driver’s route" }).or(page.locator("[aria-labelledby='driver-routes-title']"));
      const row = panel.locator("li", { hasText: "Tue, Jun 3" }).first();
      await expect(row.getByText("2 deliveries waiting for a driver")).toBeVisible();
      await row.getByLabel("Driver name").fill("Kofi");
      await row.getByLabel("Driver mobile").fill("(713) 555-2468");
      await row.getByRole("button", { name: "Text route link" }).click();
      await expect(page.getByText("Route texted to Kofi")).toBeVisible({ timeout: 15000 });
      await expect(row.getByText("Kofi · phone ending 2468 · 2 deliveries")).toBeVisible();
      await row.getByRole("button", { name: "Revoke link" }).click();
      await expect(page.getByText("Kofi's link no longer works")).toBeVisible({ timeout: 15000 });
      await expect(row.getByText("2 deliveries waiting for a driver")).toBeVisible();
    } finally {
      await deleteDriverRouteOrders(numbers, slot);
    }
  });

  test("the board shows a delivery that turned Ready while an order was open, on Back to orders (#811)", async ({ page }) => {
    const slot = "2031-06-07T18:00:00.000Z";
    const numbers = [56631];
    await deleteDriverRouteOrders(numbers, slot);
    try {
      await storeOwnerSignIn(page);
      await page.goto("/store-admin/orders?store=mama-ngozi");
      const panel = page.locator("[aria-labelledby='driver-routes-title']");
      await expect(page.getByText("Sat, Jun 7")).toHaveCount(0);
      await insertDriverRouteOrders({ numbers, slot });
      // The inbox's poll brings the order in; the page itself is not reloaded.
      const orderButton = page.getByRole("button", { name: /#56631/ });
      await expect(orderButton).toBeVisible({ timeout: 15000 });
      await orderButton.click();
      await page.getByRole("button", { name: "Back to orders" }).click();
      await expect(panel.locator("li", { hasText: "Sat, Jun 7" }).getByText("1 delivery waiting for a driver")).toBeVisible({ timeout: 5000 });
    } finally {
      await deleteDriverRouteOrders(numbers, slot);
    }
  });

  test("the driver's link lists stops nearest-next, needs no login, is not indexable, and marks out for delivery", async ({ page }) => {
    const slot = "2031-06-04T18:00:00.000Z";
    const numbers = [56611, 56612];
    const token = `e2e-route-${Date.now()}-abcdefghijklmnopqrstuvwxyz`;
    await insertDriverRouteOrders({ numbers, slot, token });
    try {
      const response = await page.goto(`/driver/${token}?store=mama-ngozi`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["x-robots-tag"]).toContain("noindex");
      await expect(page.locator("meta[name='robots']")).toHaveAttribute("content", /noindex/);

      const stops = page.locator("ol > li");
      await expect(stops).toHaveCount(2);
      await expect(stops.nth(0)).toContainText("100 Main St");
      await expect(stops.nth(0)).toContainText("Frozen");
      await expect(stops.nth(1)).toContainText("500 Main St");
      await expect(stops.nth(1)).toContainText("Gate code 4411");
      await expect(stops.nth(0).getByRole("link", { name: "Navigate" }))
        .toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=100%20Main%20St/);

      await stops.nth(0).getByRole("button", { name: "Out for delivery" }).click();
      await expect(page.getByText("Out for delivery", { exact: true }).first()).toBeVisible();
      await expect(stops.nth(0).getByText("Take delivery photo")).toBeVisible({ timeout: 15000 });
    } finally {
      await deleteDriverRouteOrders(numbers, slot);
    }
  });

  test("a revoked link, or a link opened on another store, is a 404", async ({ page }) => {
    const slot = "2031-06-05T18:00:00.000Z";
    const numbers = [56621];
    const token = `e2e-route-${Date.now()}-revoked-abcdefghijklmnopqrstuvwxyz`;
    const live = `e2e-route-${Date.now()}-live-abcdefghijklmnopqrstuvwxyz`;
    await insertDriverRouteOrders({ numbers, slot, token, revoked: true });
    const liveSlot = "2031-06-06T18:00:00.000Z";
    await insertDriverRouteOrders({ numbers: [56622], slot: liveSlot, token: live });
    try {
      expect((await page.goto(`/driver/${token}?store=mama-ngozi`))?.status()).toBe(404);
      expect((await page.goto(`/driver/${live}?store=tante-marie`))?.status()).toBe(404);
      expect((await page.goto(`/driver/${live}?store=mama-ngozi`))?.status()).toBe(200);
    } finally {
      await deleteDriverRouteOrders(numbers, slot);
      await deleteDriverRouteOrders([56622], liveSlot);
    }
  });
});

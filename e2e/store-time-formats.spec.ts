import { test, expect } from "@playwright/test";
import { deleteBatchOrders, insertCourierPackingOrder, insertInboxOrder, insertRecoveryOrder, setCourierDropoff, setOrderTimes } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";
import { storeUrl } from "./urls";

const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";

// mama-ngozi is in America/Chicago; the browser is in Honolulu, four hours behind it in November (#737).
test.describe("operational times in a browser away from the store's zone", () => {
  test.use({ timezoneId: "Pacific/Honolulu" });

  test("the order card and the substitution deadline show the store's clock, labelled", async ({ page }, testInfo) => {
    const number = 737_100 + testInfo.parallelIndex * 10 + testInfo.repeatEachIndex;
    await insertRecoveryOrder({ number, token: `e2e-737-subs-${number}-${Date.now()}`, substitutions: true });
    try {
      // 21:05 UTC is 3:05 PM CST (11:05 AM in Honolulu); 21:35 UTC is 3:35 PM CST.
      await setOrderTimes(number, { createdAt: new Date("2026-11-23T21:05:00Z"), substitutionExpiresAt: new Date("2027-01-05T21:35:00Z") });
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      const card = page.locator("button", { hasText: `#${number}` });
      await expect(card).toContainText("3:05 PM CST");
      await card.click();
      await expect(page.getByText(/rule applies at 3:35 PM CST/).first()).toBeVisible();
    } finally {
      await deleteBatchOrders([number]);
    }
  });

  test("the tracking page gives the courier's arrival in the store's clock, labelled", async ({ page }, testInfo) => {
    const number = 737_200 + testInfo.parallelIndex * 10 + testInfo.repeatEachIndex;
    const token = `e2e-737-eta-${number}-${Date.now()}`;
    await insertCourierPackingOrder(number, new Date(Date.now() + 20 * 60_000));
    try {
      await setCourierDropoff(number, token, new Date("2026-11-23T22:10:00Z"));
      await page.goto(`${storeUrl("mama-ngozi")}/order/${token}`);
      await expect(page.getByText("arriving about 4:10 PM CST")).toBeVisible();
      // At phone width the zone label stays on the line with its time.
      await page.setViewportSize({ width: 390, height: 844 });
      const eta = page.getByText("4:10 PM CST", { exact: true });
      const lineHeight = await eta.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
      expect((await eta.boundingBox())!.height).toBeLessThan(lineHeight * 1.5);
    } finally {
      await deleteBatchOrders([number]);
    }
  });
});

test("at phone width the order card keeps the customer's full name and the status beside the number", async ({ page }, testInfo) => {
  const number = 737_300 + testInfo.parallelIndex * 10 + testInfo.repeatEachIndex;
  await insertInboxOrder({ number, status: "AWAITING_PICKUP", capturedAmountCents: 4996 });
  try {
    await storeOwnerSignIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ORDERS_URL);
    const card = page.locator("button", { hasText: `#${number}` });
    const name = card.getByText("Adaeze Chukwu", { exact: true });
    await expect(name).toBeVisible();
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    const numberBox = await card.getByText(`#${number}`, { exact: true }).boundingBox();
    const badgeBox = await card.getByText("Ready for pickup", { exact: true }).boundingBox();
    expect(Math.abs(numberBox!.y + numberBox!.height / 2 - (badgeBox!.y + badgeBox!.height / 2))).toBeLessThan(4);
    await expect(card).toContainText("CST");
  } finally {
    await deleteBatchOrders([number]);
  }
});

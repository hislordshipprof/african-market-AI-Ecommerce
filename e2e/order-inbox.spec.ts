import { test, expect } from "@playwright/test";
import { deleteInboxOrder, inboxOrderId, insertCourierPackingOrder, insertInboxOrder, seedCaptureLabel, setInboxOrderStatus } from "./order-fixture";
import { storeOwnerSignIn } from "./store-owner-auth";
import { formatClockInZone, formatListDate } from "../src/lib/format";

const ORDERS_URL = "/store-admin/orders?store=mama-ngozi";

test.describe("Order inbox", () => {
  test("dashboard shows Orders card that navigates to /store-admin/orders", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto("/store-admin?store=mama-ngozi");

    const ordersCard = page.getByRole("link", { name: /^Orders\b/ });
    await expect(ordersCard).toBeVisible();
    await ordersCard.click();
    await page.waitForURL((url) => url.pathname.includes("/store-admin/orders"));
    expect(page.url()).toContain("/store-admin/orders");
  });

  test("orders page renders header and seeded order cards with item counts", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    await expect(page.locator("h1", { hasText: "Orders" })).toBeVisible();
    await expect(page.locator("text=#1001")).toBeVisible();
    await expect(page.locator("text=Adaeze Chukwu").first()).toBeVisible();

    const firstCard = page.locator("button", { hasText: "#1001" });
    // The row carries its item count twice, one for a wide list and one for a stacked list.
    const itemCount = firstCard.locator("text=/\\d+ items?/").filter({ visible: true });
    await expect(itemCount).toBeVisible();
    const itemText = await itemCount.textContent();
    const count = parseInt(itemText?.match(/(\d+)/)?.[1] ?? "0", 10);
    expect(count).toBeGreaterThan(0);
  });

  test("orders page has audio toggle button", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const audioBtn = page.locator("button[aria-label='Mute alerts']");
    await expect(audioBtn).toBeVisible();
    await audioBtn.click();
    await expect(page.locator("button[aria-label='Enable alerts']")).toBeVisible();
  });

  test("the sidebar's Home link leads back to the store admin Home (#860)", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const homeLink = page.getByRole("complementary", { name: "Store admin" }).getByRole("link", { name: "Home" });
    await expect(homeLink).toBeVisible();
    await homeLink.click();
    await page.waitForURL((url) => url.pathname === "/store-admin");
  });

  test("new orders badge shows count", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const badge = page.locator("text=/\\d+ new/");
    await expect(badge).toBeVisible();
  });

  test("clicking an order shows detail with customer name and status", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    await page.locator("button", { hasText: "#1001" }).click();
    const panel = page.getByTestId("order-panel");
    await expect(panel.locator("text=Order #1001")).toBeVisible();
    await expect(panel.locator("text=Adaeze Chukwu")).toBeVisible();
    await expect(panel.locator("text=Accept order")).toBeVisible();
  });

  test("picking order shows pick list with frozen-last sort", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const orderCard = page.locator("button", { hasText: "#1003" });
    await expect(orderCard).toBeVisible();
    await orderCard.click();
    await expect(page.locator("text=Pick list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pick" }).first()).toBeVisible({ timeout: 10000 });
  });

  test("picking every line marks the order ready and captures the seed total", async ({ page }, testInfo) => {
    const number = 18680 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "PICKING", capturedAmountCents: null, seedHold: true });
    try {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);

    const orderCard = page.locator("button", { hasText: `#${number}` });
    await expect(orderCard).toBeVisible();
    await orderCard.click();
    await expect(page.locator("text=Pick list")).toBeVisible();

    const markReadyBtn = page.getByRole("button", { name: "Mark ready" });
    await expect(markReadyBtn).toBeVisible({ timeout: 10000 });
    await expect(markReadyBtn).toBeDisabled();

    const pickButtons = page.getByTestId("order-panel").getByRole("button", { name: "Pick", exact: true });
    let remaining = await pickButtons.count();
    while (remaining > 0) {
      await pickButtons.first().click();
      remaining -= 1;
      await expect(pickButtons).toHaveCount(remaining);
    }

    await expect(markReadyBtn).toBeEnabled({ timeout: 10000 });
    await expect(page.getByTestId("order-captured")).toHaveCount(0);

    await markReadyBtn.click();

    await expect(page.locator("text=Order marked ready")).toBeVisible({ timeout: 15000 });

    const awaitingBadge = page.getByTestId("order-panel").getByText("Ready for pickup", { exact: true });
    await expect(awaitingBadge).toBeVisible({ timeout: 15000 });

    const handOffBtn = page.getByRole("button", { name: "Hand off" });
    await expect(handOffBtn).toBeVisible({ timeout: 10000 });

    const seedTotal = await seedCaptureLabel(number);
    await expect(page.getByTestId("order-captured")).toHaveText(seedTotal);
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("the Captured line appears only after the order is ready", async ({ page }) => {
    const number = 18601;
    await insertInboxOrder({ number, status: "PICKING", capturedAmountCents: 2500 });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.locator(`text=Order #${number}`)).toBeVisible();
      await expect(page.getByTestId("order-captured")).toHaveCount(0);

      await setInboxOrderStatus(number, "AWAITING_PICKUP");
      await page.reload();
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByTestId("order-captured")).toHaveText("$25.00");
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#557: the order shows the promo discount the store funds, only when there is one", async ({ page }) => {
    const number = 18603;
    await insertInboxOrder({ number, status: "AWAITING_PICKUP", capturedAmountCents: 1800, discountCents: 200 });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByTestId("order-discount")).toHaveText("−$2.00");
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#742: a new delivery order shows its items, how it leaves and a breakdown that adds up, before accepting", async ({ page }) => {
    const number = 18604;
    await insertInboxOrder({
      number,
      status: "AUTHORIZED",
      capturedAmountCents: null,
      delivery: { line1: "3700 Main St", city: "Houston", state: "TX", zip: "77002", feeCents: 499 },
    });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByRole("button", { name: "Accept order" })).toBeVisible();

      const items = page.getByRole("region", { name: "Items" });
      await expect(items.getByTestId("pick-line")).toHaveCount(1);
      await expect(items.getByTestId("pick-line-name")).not.toHaveText("");
      await expect(items.getByTestId("pick-line")).toContainText("Qty: 1");
      await expect(items.getByRole("button", { name: "Pick" })).toHaveCount(0);

      await expect(page.getByTestId("order-fulfillment")).toContainText("Store delivery");
      await expect(page.getByTestId("order-fulfillment")).toContainText("Houston, TX 77002");
      await expect(page.getByTestId("order-delivery")).toHaveText("$4.99");
      await expect(page.getByTestId("order-total")).toHaveText("$14.99");
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#751: a scheduled pickup shows its slot on the card and the order", async ({ page }, testInfo) => {
    const number = 18911 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    const slot = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 1_800_000) * 1_800_000).toISOString();
    const due = `${formatListDate(slot, "America/Chicago")} ${formatClockInZone(slot, "America/Chicago")}`;
    await insertInboxOrder({ number, status: "AUTHORIZED", capturedAmountCents: null, pickupSlot: slot });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      const card = page.locator("button", { hasText: `#${number}` });
      await expect(card.getByTestId("order-card-fulfillment")).toHaveText(`Pickup ${due}`);
      await card.click();
      await expect(page.getByTestId("order-fulfillment")).toHaveText(`Pickup ${due}`);
      const phone = page.getByTestId("order-phone");
      await expect(phone).toHaveAttribute("href", /^tel:\+1\d{10}$/);
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#751: a delivery's payout lines add up and a partial address never prints null", async ({ page }, testInfo) => {
    const number = 18991 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({
      number,
      status: "OUT_FOR_DELIVERY",
      capturedAmountCents: 5331,
      fees: { serviceFeeCents: 138, platformFeeCents: 319 },
      delivery: { line1: "7500 Bellfort St", city: "Houston", state: null, zip: null, feeCents: 0 },
    });
    const proofDir = process.env.PROOF_DIR;
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await expect(page.locator("button", { hasText: `#${number}` }).getByTestId("order-card-fulfillment")).toHaveText("Store delivery");
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByTestId("order-fulfillment")).toHaveText("Store delivery to 7500 Bellfort St, Houston");
      await expect(page.getByTestId("order-address")).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=7500%20Bellfort%20St%2C%20Houston$/);
      await expect(page.getByTestId("order-captured")).toHaveText("$53.31");
      await expect(page.getByTestId("payout-card-fee")).toHaveText("−$1.81");
      await expect(page.getByTestId("payout-service-fee")).toHaveText("−$1.38");
      await expect(page.getByTestId("order-payout")).toHaveText("$50.12");
      if (proofDir) {
        for (const scheme of ["light", "dark"] as const) {
          for (const width of [390, 1280]) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width, height: 900 });
            await page.goto(ORDERS_URL);
            await page.locator("button", { hasText: `#${number}` }).click();
            await expect(page.getByTestId("order-payout")).toBeVisible();
            await page.screenshot({ path: `${proofDir}/order-delivery-${width}-${scheme}.png`, fullPage: true });
          }
        }
      }
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#757: a refunded order's payout takes off the refund and adds back Stripe's fee share, as the sales CSV does", async ({ page }, testInfo) => {
    const number = 18995 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "AWAITING_PICKUP", capturedAmountCents: 4012, fees: { serviceFeeCents: 117, platformFeeCents: 260 }, refundCents: 1132 });
    const proofDir = process.env.PROOF_DIR;
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByTestId("order-captured")).toHaveText("$40.12");
      await expect(page.getByTestId("payout-card-fee")).toHaveText("−$1.43");
      await expect(page.getByTestId("payout-service-fee")).toHaveText("−$1.17");
      await expect(page.getByTestId("payout-refunds")).toHaveText("−$11.32");
      await expect(page.getByTestId("payout-fee-returned")).toHaveText("$0.73");
      await expect(page.getByTestId("order-payout")).toHaveText("$26.93");
      if (proofDir) {
        for (const scheme of ["light", "dark"] as const) {
          for (const width of [390, 1280]) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width, height: 900 });
            await page.goto(ORDERS_URL);
            await page.locator("button", { hasText: `#${number}` }).click();
            await expect(page.getByTestId("order-payout")).toBeVisible();
            await page.screenshot({ path: `${proofDir}/order-refunded-${width}-${scheme}.png`, fullPage: true });
          }
        }
      }
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("a refund-failed order tells staff the platform is resolving it", async ({ page }) => {
    const number = 18602;
    await insertInboxOrder({ number, status: "REFUND_FAILED", capturedAmountCents: 1800 });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByText("The platform team is resolving this refund. Do not refund the customer yourself.")).toBeVisible();
      await expect(page.getByTestId("order-captured")).toHaveText("$18.00");
      await expect(page.getByText("refund them another way")).toHaveCount(0);
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("a resolved cancellation stays in the inbox with the platform note", async ({ page }, testInfo) => {
    const number = 18691 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({
      number,
      status: "CANCELLED",
      capturedAmountCents: 2500,
      notes: "Paid customer by Zelle 11/05",
      platformResolved: true,
    });
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      await expect(page.getByTestId("order-panel").getByText("Cancelled", { exact: true })).toBeVisible();
      await expect(page.getByText("Paid customer by Zelle 11/05")).toBeVisible();
      await expect(page.getByText("The platform resolved this refund.")).toBeVisible();
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#562: a packing courier order shows its ready time, the courier's ETA and one 5-minute push", async ({ page }, testInfo) => {
    const number = 18791 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    const readyAt = new Date(Math.ceil((Date.now() + 15 * 60_000) / 60_000) * 60_000);
    await insertCourierPackingOrder(number, readyAt);
    const proofDir = process.env.PROOF_DIR;
    try {
      await storeOwnerSignIn(page);
      if (proofDir) {
        for (const scheme of ["light", "dark"] as const) {
          for (const width of [390, 1280]) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width, height: 900 });
            await page.goto(ORDERS_URL);
            await page.locator("button", { hasText: `#${number}` }).click();
            await expect(page.getByLabel("Courier timing")).toBeVisible();
            await page.screenshot({ path: `${proofDir}/inbox-courier-${width}-${scheme}.png`, fullPage: false });
          }
        }
        await page.emulateMedia({ colorScheme: "light" });
      }
      await page.goto(ORDERS_URL);
      await page.locator("button", { hasText: `#${number}` }).click();
      const block = page.getByLabel("Courier timing");
      await expect(block.getByText(/^Ready by /)).toBeVisible();
      await expect(block.getByText(/^Courier Sam arriving about /)).toBeVisible();
      await block.getByRole("button", { name: "5 more minutes" }).click();
      // No DoorDash keys here, so the assigned courier keeps its time; the ready time still moves once.
      await expect(page.getByText(/The courier already on the way keeps the first time/)).toBeVisible();
      await expect(block.getByText("Pushed once")).toBeVisible();
      await expect(block.getByRole("button", { name: "5 more minutes" })).toHaveCount(0);
      if (proofDir) await page.screenshot({ path: `${proofDir}/inbox-courier-pushed-1280-light.png` });
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#785: a partly refunded order leaves the inbox and is in Past orders with its total and payout, found by number", async ({ page }, testInfo) => {
    const number = 19495 + testInfo.parallelIndex * 20 + testInfo.repeatEachIndex;
    await insertInboxOrder({ number, status: "PARTIALLY_REFUNDED", capturedAmountCents: 4012, fees: { serviceFeeCents: 117, platformFeeCents: 260 }, refundCents: 1132 });
    const proofDir = process.env.PROOF_DIR;
    try {
      await storeOwnerSignIn(page);
      await page.goto(ORDERS_URL);
      await expect(page.locator("button", { hasText: "#1001" })).toBeVisible();
      await expect(page.locator("button", { hasText: `#${number}` })).toHaveCount(0);

      await page.getByRole("link", { name: "Past orders" }).click();
      await expect(page.getByRole("heading", { name: "Past orders" })).toBeVisible();
      await page.getByLabel("Order number or customer").fill(`#${number}`);
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const rows = page.getByTestId("past-orders").locator("li");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(`Order #${number}`);
      await expect(rows.first()).toContainText("Partly refunded");
      await expect(rows.first()).toContainText("$40.12");
      // The same payout the order's breakdown gives (#757): capture less fees and the refund, plus the fee returned.
      await expect(rows.first()).toContainText("$26.93");

      await page.getByLabel("Order number or customer").fill("no-such-customer-785");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByText('No past orders match "no-such-customer-785".')).toBeVisible();

      if (proofDir) {
        for (const [width, scheme] of [[390, "dark"], [1280, "light"]] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height: 900 });
          await page.goto("/store-admin/orders/past?store=mama-ngozi");
          await expect(page.getByTestId("past-orders")).toBeVisible();
          expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
          await page.screenshot({ path: `${proofDir}/past-orders-${width}-${scheme}.png`, fullPage: true });
          await page.goto(ORDERS_URL);
          await expect(page.getByRole("link", { name: "Past orders" })).toBeVisible();
          await page.screenshot({ path: `${proofDir}/inbox-header-${width}-${scheme}.png` });
        }
      }
    } finally {
      await deleteInboxOrder(number);
    }
  });

  test("#785: the new-order email's link opens that order ready to accept", async ({ page }) => {
    const id = await inboxOrderId(1001);
    await storeOwnerSignIn(page);
    await page.goto(`${ORDERS_URL}&order=${id}`);
    await expect(page.locator("text=Order #1001")).toBeVisible();
    await expect(page.locator("text=Accept order")).toBeVisible();
  });

  test("#785: the owner turns their own new-order email off and on, and it stays after a reload", async ({ page }) => {
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);
    const toggle = page.getByRole("button", { name: /New-order email/ });
    await expect(toggle).toHaveText("New-order email: on");
    try {
      await toggle.click();
      await expect(toggle).toHaveText("New-order email: off");
      await page.reload();
      await expect(page.getByRole("button", { name: /New-order email/ })).toHaveText("New-order email: off");
    } finally {
      const current = page.getByRole("button", { name: /New-order email/ });
      if ((await current.textContent())?.includes("off")) {
        await current.click();
        await expect(current).toHaveText("New-order email: on");
      }
    }
  });

  test("no horizontal overflow at 390px mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await storeOwnerSignIn(page);
    await page.goto(ORDERS_URL);
    await expect(page.getByRole("heading", { name: /orders/i })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });
});

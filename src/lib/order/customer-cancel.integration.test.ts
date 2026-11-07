import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeScoped } from "../db";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { acceptOrder, customerCancelOrder } from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("customer cancel window", () => {
  let raw: PrismaClient;
  let storeId = "";
  let customerId = "";
  let cartId = "";
  let number = 70000;

  beforeAll(async () => {
    process.env.E2E_FAKE_STRIPE = "1";
    delete process.env.VERCEL;
    resetFakeCheckoutPayments();
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    const store = await raw.store.create({
      data: {
        slug: `cancel-${suffix}`,
        name: "Cancel Store",
        themePreset: "palm-and-shea",
        status: "active",
        stripeOnboardingStatus: "complete",
        stripeAccountId: `acct_cancel_${suffix}`,
      },
    });
    storeId = store.id;
    customerId = (await storeScoped(storeId).customer.create({ data: { storeId, name: "Ada" } })).id;
    cartId = (await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } })).id;
  });

  afterAll(async () => {
    if (!storeId) return;
    await storeScoped(storeId).orderLine.deleteMany({});
    await storeScoped(storeId).order.deleteMany({});
    await storeScoped(storeId).customer.deleteMany({});
    await storeScoped(storeId).cart.deleteMany({});
    await raw.auditLog.deleteMany({ where: { storeId } });
    await raw.store.delete({ where: { id: storeId } });
    await raw.$disconnect();
  });

  async function order(status: "AUTHORIZED" | "CANCELLING", until: Date) {
    const pi = await getCheckoutPayments().createPaymentIntent(
      { amount: 800, currency: "usd", payment_method: "pm_card_visa" },
      `cancel-${randomUUID()}`,
    );
    await getCheckoutPayments().confirmPaymentIntent(pi.id, { payment_method: "pm_card_visa" });
    number += 1;
    return storeScoped(storeId).order.create({
      data: {
        storeId,
        number,
        customerId,
        sourceCartId: cartId,
        status,
        fulfillment: "pickup",
        subtotalCents: 800,
        bufferCents: 0,
        totalAuthorizedCents: 800,
        totalCents: 800,
        paymentIntentId: pi.id,
        cancellableUntil: until,
      },
    });
  }

  it("a cancel that waits on the lock loses when the window closes first", async () => {
    const row = await order("AUTHORIZED", new Date(Date.now() + 60_000));
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL ROLE app_user");
      await holder.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      await holder.query("SELECT 1 FROM stores WHERE id = $1 FOR UPDATE", [storeId]);
      const pending = customerCancelOrder({
        storeId,
        orderId: row.id,
        cartId,
        actorUserId: null,
        actorEmail: "guest@checkout",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const updated = await holder.query(
        "UPDATE orders SET cancellable_until = TIMESTAMP '2000-01-01 00:00:00' WHERE id = $1",
        [row.id],
      );
      expect(updated.rowCount).toBe(1);
      await holder.query("COMMIT");
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("window");
      expect(result.code).toBe("window_closed");
      const after = await storeScoped(storeId).order.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe("AUTHORIZED");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("retries a cancel that already claimed CANCELLING after the window", async () => {
    const row = await order("CANCELLING", new Date(Date.now() - 60_000));
    const result = await customerCancelOrder({
      storeId,
      orderId: row.id,
      cartId,
      actorUserId: null,
      actorEmail: "guest@checkout",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const after = await storeScoped(storeId).order.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("CANCELLED");
  });

  it("refuses the store accept while the window is open and allows it after", async () => {
    const open = await order("AUTHORIZED", new Date(Date.now() + 60_000));
    const early = await acceptOrder(storeId, open.id, 15);
    expect(early.ok).toBe(false);
    if (early.ok) throw new Error("accepted early");
    expect(early.error).toContain("cancel");
    const closed = await order("AUTHORIZED", new Date(Date.now() - 60_000));
    const late = await acceptOrder(storeId, closed.id, 15);
    expect(late.ok, JSON.stringify(late)).toBe(true);
    const after = await storeScoped(storeId).order.findUnique({ where: { id: closed.id } });
    expect(after?.status).toBe("ACCEPTED");
  });
});

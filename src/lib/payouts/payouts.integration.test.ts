import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { setStripeProvider } from "@/lib/stripe";
import { fakeStripeProvider, loginLinksCreated, reset, setNextPayoutsFailure } from "@/lib/stripe/fake";
import { fakePayoutPaymentIntentId, FAKE_PAYOUT_ORDERS } from "@/lib/stripe/fake-payouts";

const session = vi.hoisted(() => ({
  current: null as null | { store: { id: string; slug: string; stripeAccountId: string | null } },
}));
vi.mock("@/lib/store-admin/session", () => ({
  requireStoreOwner: async () => {
    // Staff and signed-out users are redirected by the real guard; nothing after it runs.
    if (!session.current) throw new Error("REDIRECT:/store-admin");
    return session.current;
  },
}));

import { GET as csv } from "@/app/store-admin/payouts/[payoutId]/csv/route";
import { POST as dashboard } from "@/app/store-admin/payouts/stripe-dashboard/route";
import { PAYOUTS_ERROR, storePayoutDetail, storePayouts } from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("store payouts (#548, lane DB)", () => {
  const run = `po548-${Date.now()}`;
  const accountA = `acct_${run.replace(/-/g, "")}a`;
  const accountB = `acct_${run.replace(/-/g, "")}b`;
  let raw: PrismaClient;
  const storeA = { id: "", slug: `${run}-a`, stripeAccountId: accountA as string | null };
  const storeB = { id: "", slug: `${run}-b`, stripeAccountId: accountB as string | null };
  const firstPayout = `po_fake_${accountA}_1`;
  const logged: string[] = [];

  async function seedOrders(storeId: string, account: string, numberBase: number, keys: readonly string[]) {
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
      const customer = await tx.customer.create({ data: { storeId, name: "Payout shopper" } });
      for (const [i, o] of FAKE_PAYOUT_ORDERS.entries()) {
        if (!keys.includes(o.key)) continue;
        await tx.order.create({
          data: {
            storeId, customerId: customer.id, number: numberBase + i, status: "DELIVERED", fulfillment: o.fulfillment,
            subtotalCents: o.capturedAmountCents, bufferCents: 0, totalAuthorizedCents: o.capturedAmountCents,
            totalCents: o.capturedAmountCents, capturedAmountCents: o.capturedAmountCents, platformFeeCents: o.platformFeeCents,
            serviceFeeCents: o.serviceFeeCents, tipCents: o.tipCents, deliveryFeeCents: o.deliveryFeeCents,
            paymentIntentId: fakePayoutPaymentIntentId(o.key, account),
          },
        });
      }
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    storeA.id = (await raw.store.create({ data: { slug: storeA.slug, name: "Store A", stripeAccountId: accountA } })).id;
    storeB.id = (await raw.store.create({ data: { slug: storeB.slug, name: "Store B", stripeAccountId: accountB } })).id;
    await seedOrders(storeA.id, accountA, 101, ["a", "b"]);
    // Store B holds an order whose PaymentIntent sits in A's payout: A must never see it.
    await seedOrders(storeB.id, accountA, 201, ["c"]);
  });

  beforeEach(() => {
    reset();
    setStripeProvider(fakeStripeProvider);
    logged.length = 0;
    for (const level of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setStripeProvider(null);
    session.current = null;
  });

  afterAll(async () => {
    await raw?.$disconnect();
  });

  it("lists the store's own account payouts with amount, arrival date and status", async () => {
    const spy = vi.spyOn(fakeStripeProvider, "listPayouts");
    const result = await storePayouts(storeA);
    expect(spy).toHaveBeenCalledWith(accountA, 12);
    expect(result.ok && result.payouts.map((p) => [p.amountCents, p.status])).toEqual([[3468, "in_transit"], [5884, "paid"]]);
  });

  it("breaks a payout into the store's orders, summing to the payout", async () => {
    const result = await storePayoutDetail(storeA, firstPayout);
    if (!result.ok) throw new Error(result.error);
    expect(result.breakdown.rows.map((r) => [r.number, r.netCents])).toEqual([[101, 3679], [102, 2205]]);
    expect(result.breakdown.rows.reduce((s, r) => s + r.netCents, 0)).toBe(result.payout.amountCents);
  });

  it("never shows another store's order, even when its PaymentIntent is in this payout", async () => {
    const result = await storePayoutDetail(storeA, `po_fake_${accountA}_2`);
    if (!result.ok) throw new Error(result.error);
    expect(result.breakdown.rows.map((r) => r.number)).toEqual([102]);
    expect(result.breakdown.otherCents).toBe(3935);
  });

  it("asks Stripe with the session store's account, so store B cannot open A's payout", async () => {
    const spy = vi.spyOn(fakeStripeProvider, "retrievePayout");
    session.current = { store: storeB };
    const res = await csv(new Request("http://localhost/x"), { params: Promise.resolve({ payoutId: firstPayout }) });
    expect(res.status).toBe(404);
    expect(spy).toHaveBeenCalledWith(accountB, firstPayout);
    expect(await res.text()).not.toContain("Store A");
  });

  it("gives the owner a CSV of the payout", async () => {
    session.current = { store: storeA };
    const res = await csv(new Request("http://localhost/x"), { params: Promise.resolve({ payoutId: firstPayout }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(`${storeA.slug}-payout-2026-11-06.csv`);
    expect(await res.text()).toContain("#101,45.50,3.00,0.00,1.71,10.00,36.79\r\n");
  });

  it("refuses staff before any Stripe call", async () => {
    const spy = vi.spyOn(fakeStripeProvider, "createLoginLink");
    const post = new Request("http://localhost/store-admin/payouts/stripe-dashboard", {
      method: "POST", headers: { origin: "http://localhost", host: "localhost" },
    });
    await expect(dashboard(post)).rejects.toThrow(/REDIRECT/);
    await expect(csv(new Request("http://localhost/x"), { params: Promise.resolve({ payoutId: firstPayout }) })).rejects.toThrow(/REDIRECT/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("redirects to a fresh login link for the session store and never logs it", async () => {
    session.current = { store: storeA };
    const res = await dashboard(new Request("http://localhost/store-admin/payouts/stripe-dashboard", {
      method: "POST", headers: { origin: "http://localhost", host: "localhost" },
    }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`https://connect.stripe.com/express/fake-login/${accountA}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(loginLinksCreated).toEqual([accountA]);
    expect(logged.join("\n")).not.toContain("fake-login");
  });

  it("refuses a cross-site POST for the login link", async () => {
    session.current = { store: storeA };
    const res = await dashboard(new Request("http://localhost/store-admin/payouts/stripe-dashboard", {
      method: "POST", headers: { origin: "https://evil.example", host: "localhost" },
    }));
    expect(res.status).toBe(403);
    expect(loginLinksCreated).toEqual([]);
  });

  it("shows a plain message on a Stripe error and keeps the raw text in the server log", async () => {
    setNextPayoutsFailure("Raw provider text: acct_secret is restricted");
    const result = await storePayouts(storeA);
    expect(result).toEqual({ ok: false, notFound: false, error: PAYOUTS_ERROR });
    expect(logged.join("\n")).toContain("Raw provider text: acct_secret is restricted");

    session.current = { store: storeA };
    vi.spyOn(fakeStripeProvider, "createLoginLink").mockRejectedValueOnce(new Error("Raw: no Express Dashboard"));
    const res = await dashboard(new Request("http://localhost/store-admin/payouts/stripe-dashboard", {
      method: "POST", headers: { origin: "http://localhost", host: "localhost" },
    }));
    expect(res.headers.get("Location")).toBe(`/store-admin/payouts?store=${storeA.slug}&dashboard=failed`);
    expect(logged.join("\n")).toContain("Raw: no Express Dashboard");
  });
});

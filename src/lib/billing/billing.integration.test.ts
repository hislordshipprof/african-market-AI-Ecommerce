import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { testPrismaClient } from "@/lib/test-prisma";
import { POST } from "@/app/api/webhooks/stripe/route";
import { platformAdmin, storeScoped } from "../db";
import { setStripeProvider } from "../stripe";
import { stripeProvider } from "../stripe/provider";
import { fakeStripeProvider } from "../stripe/fake";
import { setEmailSenderForTests, type EmailMessage } from "../email/send";
import { storePlan } from "./plan";
import { COURIER_NOT_OFFERED, quoteCheckout } from "../checkout/service";
import { createFakeBillingProvider, PLAN_LOOKUP_KEYS, setBillingProvider } from "./provider";
import { getStoreBilling, PILOT_STORE_CAP, setPilot, startSubscription } from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("store subscriptions (lane DB)", () => {
  const run = `sub494-${Date.now()}`;
  let raw: PrismaClient;
  let secret = "";
  let storeA = "";
  let storeB = "";
  const extraStores: string[] = [];
  const sent: EmailMessage[] = [];
  const admin = { id: "system_00000000000000000000000", email: "system@platform.internal" };
  let seq = 0;

  function subscriptionEvent(
    type: string,
    sub: { id: string; customer: string; status: string; plan: "starter" | "pro"; storeId: string; trialEnd?: number | null },
    opts: { id?: string; created?: number } = {},
  ) {
    return {
      id: opts.id ?? `evt_${run}_${++seq}`,
      object: "event",
      created: opts.created ?? Math.floor(Date.now() / 1000),
      type,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: sub.id,
          object: "subscription",
          customer: sub.customer,
          status: sub.status,
          trial_end: sub.trialEnd ?? null,
          cancel_at_period_end: false,
          metadata: { platform_store_id: sub.storeId },
          items: {
            data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, price: { lookup_key: PLAN_LOOKUP_KEYS[sub.plan] } }],
          },
        },
      },
    };
  }

  function invoiceEvent(type: string, inv: { customer: string; subscription: string }, opts: { created?: number } = {}) {
    return {
      id: `evt_${run}_${++seq}`,
      object: "event",
      created: opts.created ?? Math.floor(Date.now() / 1000),
      type,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: `in_${run}_${seq}`,
          object: "invoice",
          customer: inv.customer,
          parent: { subscription_details: { subscription: inv.subscription, metadata: {} } },
        },
      },
    };
  }

  async function deliver(event: object) {
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return POST(
      new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": signature },
      }),
    );
  }

  async function newStore(tag: string, data: Record<string, unknown> = {}) {
    const id = (await raw.store.create({ data: { slug: `sub-${tag}-${run}`, name: `Sub ${tag}` } })).id;
    extraStores.push(id);
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeSubscription.create({ data: { storeId: id, ...data } });
    });
    return id;
  }

  const row = (storeId: string) => platformAdmin.storeSubscription.findUniqueOrThrow({ where: { storeId } });

  beforeAll(async () => {
    secret = process.env.STRIPE_WEBHOOK_SECRET?.split(",")[0]?.trim() || "whsec_test_ticket_494";
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
    if (!process.env.STRIPE_SECRET_KEY) vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    raw = testPrismaClient();
    await raw.$connect();
    storeA = (await raw.store.create({ data: { slug: `sub-a-${run}`, name: "Sub A" } })).id;
    storeB = (await raw.store.create({ data: { slug: `sub-b-${run}`, name: "Sub B" } })).id;
    setStripeProvider({
      ...fakeStripeProvider,
      verifyWebhookSignature: (input) => stripeProvider.verifyWebhookSignature(input),
    });
    setEmailSenderForTests({ send: async (m) => (sent.push(m), { id: `email_${sent.length}` }) });
  });

  afterAll(async () => {
    setStripeProvider(null);
    setBillingProvider(null);
    setEmailSenderForTests(null);
    vi.unstubAllEnvs();
    if (!raw) return;
    const ids = [storeA, storeB, ...extraStores];
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.auditLog.deleteMany({ where: { storeId: { in: ids } } });
      await tx.stripeBillingEvent.deleteMany({ where: { OR: [{ storeId: { in: ids } }, { id: { startsWith: `evt_${run}` } }] } });
      await tx.storeSubscription.deleteMany({ where: { storeId: { in: ids } } });
      await tx.assistantChatMonth.deleteMany({ where: { storeId: { in: ids } } });
      await tx.store.deleteMany({ where: { id: { in: ids } } });
    });
    await raw.$disconnect();
  });

  it("a signed subscription event sets the plan, and a replayed event changes nothing", async () => {
    const created = subscriptionEvent("customer.subscription.created", {
      id: `sub_${run}_a`, customer: `cus_${run}_a`, status: "active", plan: "pro", storeId: storeA,
    });
    expect((await deliver(created)).status).toBe(200);
    expect(await storePlan(storeA)).toBe("pro");
    expect(await storePlan(storeB)).toBe("starter");

    const before = await platformAdmin.storeSubscription.findUniqueOrThrow({ where: { storeId: storeA } });
    const audits = await platformAdmin.auditLog.count({ where: { storeId: storeA, action: "subscription.plan_changed" } });
    expect(audits).toBe(1);

    expect((await deliver(created)).status).toBe(200);
    const after = await platformAdmin.storeSubscription.findUniqueOrThrow({ where: { storeId: storeA } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await platformAdmin.auditLog.count({ where: { storeId: storeA, action: "subscription.plan_changed" } })).toBe(1);
  });

  it("a downgrade switches the store to Starter; an older event arriving late is skipped", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sub = { id: `sub_${run}_a`, customer: `cus_${run}_a`, status: "active", storeId: storeA };
    await deliver(subscriptionEvent("customer.subscription.updated", { ...sub, plan: "starter" }, { created: now + 5 }));
    expect(await storePlan(storeA)).toBe("starter");

    await deliver(subscriptionEvent("customer.subscription.updated", { ...sub, plan: "pro" }, { created: now + 1 }));
    expect(await storePlan(storeA)).toBe("starter");
  });

  it("courier at checkout: Pro passes the plan gate, Starter is refused, pickup works on Starter", async () => {
    const contact = { name: "Ada", email: "ada@example.test", phone: "+12025550123" };
    const problems = async (storeId: string, fulfillment: "courier" | "pickup") =>
      (await quoteCheckout(storeId, 0, "no-cart", contact, fulfillment)).problems.map((p) => p.message);
    await platformAdmin.storeSubscription.update({ where: { storeId: storeA }, data: { plan: "pro" } });
    expect(await problems(storeA, "courier")).not.toContain(COURIER_NOT_OFFERED);
    expect(await problems(storeB, "courier")).toContain(COURIER_NOT_OFFERED);
    expect(await problems(storeB, "pickup")).not.toContain(COURIER_NOT_OFFERED);
    await platformAdmin.storeSubscription.update({ where: { storeId: storeA }, data: { plan: "starter" } });
    expect(await problems(storeA, "courier")).toContain(COURIER_NOT_OFFERED);
  });

  it("a failed invoice shows the owner banner state and alerts admins; the storefront stays up", async () => {
    sent.length = 0;
    const res = await deliver(invoiceEvent("invoice.payment_failed", { customer: `cus_${run}_a`, subscription: `sub_${run}_a` }));
    expect(res.status).toBe(200);
    const row = await storeScoped(storeA).storeSubscription.findUniqueOrThrow({ where: { storeId: storeA } });
    expect(row.paymentFailedAt).not.toBeNull();
    const store = await platformAdmin.store.findUniqueOrThrow({ where: { id: storeA } });
    expect(store.status).toBe("active");
    const adminCount = await raw.user.count({ where: { role: "platform_admin" } });
    expect(sent.filter((m) => m.subject.includes("Subscription payment failed"))).toHaveLength(adminCount);

    await deliver(invoiceEvent("invoice.paid", { customer: `cus_${run}_a`, subscription: `sub_${run}_a` }));
    const recovered = await storeScoped(storeA).storeSubscription.findUniqueOrThrow({ where: { storeId: storeA } });
    expect(recovered.paymentFailedAt).toBeNull();
  });

  it("an event naming another store's customer cannot move that store", async () => {
    const forged = subscriptionEvent("customer.subscription.updated", {
      id: `sub_${run}_forged`, customer: `cus_${run}_a`, status: "active", plan: "pro", storeId: storeB,
    });
    await deliver(forged);
    expect(await storePlan(storeB)).toBe("starter");
  });

  it("a pilot store's checkout carries 3 free months, and the offer stops at 5 stores", async () => {
    const fake = createFakeBillingProvider();
    setBillingProvider(fake);
    const already = await platformAdmin.storeSubscription.count({ where: { pilot: true } });
    const room = PILOT_STORE_CAP - already;
    expect(await setPilot(storeB, true, admin)).toEqual({ ok: true });
    const now = new Date("2026-11-13T12:00:00Z");
    await startSubscription({ storeId: storeB, storeName: "Sub B", plan: "starter", owner: admin, returnUrl: "http://localhost/x", now });
    expect(fake.checkouts.at(-1)?.trialEnd).toBe(Math.floor(Date.parse("2027-02-13T12:00:00Z") / 1000));
    expect(await platformAdmin.auditLog.count({ where: { storeId: storeB, action: "subscription.pilot_granted" } })).toBe(1);

    for (let i = 1; i < room; i++) {
      const id = (await raw.store.create({ data: { slug: `sub-p${i}-${run}`, name: `Pilot ${i}` } })).id;
      extraStores.push(id);
      expect(await setPilot(id, true, admin)).toEqual({ ok: true });
    }
    const sixth = (await raw.store.create({ data: { slug: `sub-p6-${run}`, name: "Pilot 6" } })).id;
    extraStores.push(sixth);
    expect(await setPilot(sixth, true, admin)).toEqual({ ok: false, error: "The pilot offer is limited to 5 stores." });
    for (const id of [storeB, ...extraStores]) await setPilot(id, false, admin);
  });

  it("a pilot granted after subscribing moves the trial; if Stripe refuses, the pilot is not kept", async () => {
    const fake = createFakeBillingProvider();
    setBillingProvider(fake);
    fake.addSubscription(`sub_${run}_a`);
    await platformAdmin.storeSubscription.update({ where: { storeId: storeA }, data: { status: "active", stripeSubscriptionId: `sub_${run}_a` } });
    expect(await setPilot(storeA, true, admin)).toEqual({ ok: true });
    expect(fake.trialEndOf(`sub_${run}_a`)).toBeGreaterThan(Date.now() / 1000 + 80 * 86400);
    await setPilot(storeA, false, admin);

    await platformAdmin.storeSubscription.update({ where: { storeId: storeA }, data: { stripeSubscriptionId: `sub_${run}_unknown` } });
    expect(await setPilot(storeA, true, admin)).toMatchObject({ ok: false });
    expect((await platformAdmin.storeSubscription.findUniqueOrThrow({ where: { storeId: storeA } })).pilot).toBe(false);
    await platformAdmin.storeSubscription.update({ where: { storeId: storeA }, data: { stripeSubscriptionId: `sub_${run}_a` } });
  });

  it("RLS: a store reads only its own billing and cannot write it; chat counts stay per store", async () => {
    await expect(storeScoped(storeB).storeSubscription.findUnique({ where: { storeId: storeA } })).resolves.toBeNull();
    await expect(
      storeScoped(storeA).storeSubscription.update({ where: { storeId: storeA }, data: { plan: "pro", status: "active" } }),
    ).rejects.toThrow();
    await expect(
      storeScoped(storeB).storeSubscription.create({ data: { storeId: storeB, plan: "pro", status: "active" } }),
    ).rejects.toThrow();

    const month = new Date("2026-11-01T00:00:00Z");
    await storeScoped(storeA).assistantChatMonth.create({ data: { storeId: storeA, month, chats: 3 } });
    await expect(
      storeScoped(storeB).assistantChatMonth.findUnique({ where: { storeId_month: { storeId: storeA, month } } }),
    ).resolves.toBeNull();
    await expect(
      storeScoped(storeB).assistantChatMonth.create({ data: { storeId: storeA, month: new Date("2026-10-01T00:00:00Z"), chats: 0 } }),
    ).rejects.toThrow();
    const updated = await storeScoped(storeB).assistantChatMonth.updateMany({ where: { storeId: storeA }, data: { chats: 0 } });
    expect(updated.count).toBe(0);
  });

  it("B1: a second Checkout expires the first; a paid Checkout whose webhook has not landed opens nothing", async () => {
    const fake = createFakeBillingProvider();
    setBillingProvider(fake);
    const id = await newStore("co");
    const start = () => startSubscription({ storeId: id, storeName: "Sub co", plan: "pro", owner: admin, returnUrl: "http://localhost/x" });
    expect(await start()).toHaveProperty("url");
    expect(await start()).toHaveProperty("url");
    expect(fake.checkouts.map((c) => c.status)).toEqual(["expired", "open"]);

    fake.completeCheckout(fake.checkouts[1].id);
    expect(await start()).toEqual({ pending: true });
    expect(fake.checkouts).toHaveLength(2);
  });

  it("B1: a second subscription on one store is cancelled; the first keeps receiving its events", async () => {
    const fake = createFakeBillingProvider();
    setBillingProvider(fake);
    const id = await newStore("dup");
    sent.length = 0;
    const base = { customer: `cus_${run}_dup`, status: "active", storeId: id };
    await deliver(subscriptionEvent("customer.subscription.created", { ...base, id: `sub_${run}_c1`, plan: "starter" }));
    expect((await deliver(subscriptionEvent("customer.subscription.created", { ...base, id: `sub_${run}_c2`, plan: "pro" }))).status).toBe(200);
    expect([...fake.canceled]).toEqual([`sub_${run}_c2`]);
    expect(await row(id)).toMatchObject({ stripeSubscriptionId: `sub_${run}_c1`, plan: "starter" });
    expect(await platformAdmin.auditLog.count({ where: { storeId: id, action: "subscription.duplicate_canceled" } })).toBe(1);
    expect(sent.some((m) => m.subject.includes("Duplicate subscription cancelled"))).toBe(true);

    const later = Math.floor(Date.now() / 1000) + 2;
    await deliver(subscriptionEvent("customer.subscription.updated", { ...base, id: `sub_${run}_c1`, plan: "starter", status: "past_due" }, { created: later }));
    expect((await row(id)).status).toBe("past_due");
    await deliver(subscriptionEvent("customer.subscription.deleted", { ...base, id: `sub_${run}_c2`, plan: "pro", status: "canceled" }, { created: later + 1 }));
    await deliver(invoiceEvent("invoice.payment_failed", { customer: base.customer, subscription: `sub_${run}_c2` }, { created: later + 1 }));
    expect(await row(id)).toMatchObject({ stripeSubscriptionId: `sub_${run}_c1`, status: "past_due", paymentFailedAt: null });
  });

  it("B3: removing the pilot ends a running trial in Stripe; once the free months are used, removal is refused", async () => {
    const fake = createFakeBillingProvider();
    setBillingProvider(fake);
    const trialing = await newStore("rm", { status: "trialing", stripeSubscriptionId: `sub_${run}_rm`, stripeCustomerId: `cus_${run}_rm` });
    fake.addSubscription(`sub_${run}_rm`);
    expect(await setPilot(trialing, true, admin)).toEqual({ ok: true });
    expect(await setPilot(trialing, false, admin)).toEqual({ ok: true });
    expect(fake.trialEndOf(`sub_${run}_rm`)).toBe("now");
    expect((await row(trialing)).pilot).toBe(false);

    const refused = await newStore("rm2", { status: "trialing", pilot: true, stripeSubscriptionId: `sub_${run}_rm2` });
    expect(await setPilot(refused, false, admin)).toMatchObject({ ok: false });
    expect((await row(refused)).pilot).toBe(true);

    const used = await newStore("rm3", {
      status: "active",
      pilot: true,
      stripeSubscriptionId: `sub_${run}_rm3`,
      trialEndsAt: new Date(Date.now() - 86400_000),
    });
    expect(await setPilot(used, false, admin)).toEqual({
      ok: false,
      error: "This store has already had its free months, so it keeps its pilot place.",
    });
    expect((await row(used)).pilot).toBe(true);
    for (const id of [refused, used]) await platformAdmin.storeSubscription.update({ where: { storeId: id }, data: { pilot: false } });
  });

  it("N4: the free months show only when Checkout will give them; a grant expires an open Checkout", async () => {
    const fake = createFakeBillingProvider();
    setBillingProvider(fake);
    const returning = await newStore("ret", { pilot: true, status: "canceled", stripeSubscriptionId: `sub_${run}_ret` });
    expect((await getStoreBilling(returning)).pilotTrialAvailable).toBe(false);

    const fresh = await newStore("fresh");
    await startSubscription({ storeId: fresh, storeName: "Sub fresh", plan: "starter", owner: admin, returnUrl: "http://localhost/x" });
    expect(await setPilot(fresh, true, admin)).toEqual({ ok: true });
    expect(fake.checkouts.map((c) => c.status)).toEqual(["expired"]);
    expect((await getStoreBilling(fresh)).pilotTrialAvailable).toBe(true);
    await startSubscription({ storeId: fresh, storeName: "Sub fresh", plan: "starter", owner: admin, returnUrl: "http://localhost/x" });
    expect(fake.checkouts.at(-1)?.trialEnd).not.toBeNull();
    for (const id of [returning, fresh]) await platformAdmin.storeSubscription.update({ where: { storeId: id }, data: { pilot: false } });
  });

  it("N1: a failed invoice re-delivered after a newer paid one leaves no banner; a cancellation clears it", async () => {
    const id = await newStore("inv", { status: "active", stripeSubscriptionId: `sub_${run}_inv`, stripeCustomerId: `cus_${run}_inv` });
    const inv = { customer: `cus_${run}_inv`, subscription: `sub_${run}_inv` };
    const now = Math.floor(Date.now() / 1000);
    await deliver(invoiceEvent("invoice.paid", inv, { created: now }));
    await deliver(invoiceEvent("invoice.payment_failed", inv, { created: now - 60 }));
    expect((await row(id)).paymentFailedAt).toBeNull();

    await deliver(invoiceEvent("invoice.payment_failed", inv, { created: now + 60 }));
    expect((await row(id)).paymentFailedAt).not.toBeNull();
    await deliver(subscriptionEvent("customer.subscription.deleted", {
      id: inv.subscription, customer: inv.customer, status: "canceled", plan: "starter", storeId: id,
    }, { created: now + 120 }));
    expect(await row(id)).toMatchObject({ status: "canceled", paymentFailedAt: null });
  });

  it("N2: two events in the same second apply Stripe's current subscription, whatever their order", async () => {
    const fake = createFakeBillingProvider();
    setBillingProvider(fake);
    const id = await newStore("tie", { stripeCustomerId: `cus_${run}_tie` });
    const sub = { id: `sub_${run}_tie`, customer: `cus_${run}_tie`, storeId: id };
    fake.setSubscription({
      id: sub.id, customerId: sub.customer, status: "active", lookupKey: PLAN_LOOKUP_KEYS.pro,
      storeId: id, trialEnd: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
    });
    const t = Math.floor(Date.now() / 1000);
    await deliver(subscriptionEvent("customer.subscription.updated", { ...sub, status: "active", plan: "pro" }, { created: t }));
    await deliver(subscriptionEvent("customer.subscription.created", { ...sub, status: "incomplete", plan: "starter" }, { created: t }));
    expect(await row(id)).toMatchObject({ status: "active", plan: "pro" });
  });
});

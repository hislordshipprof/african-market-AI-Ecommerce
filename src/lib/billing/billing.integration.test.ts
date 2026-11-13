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
import { createFakeBillingProvider, PLAN_LOOKUP_KEYS, setBillingProvider } from "./provider";
import { PILOT_STORE_CAP, setPilot, startSubscription } from "./service";

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

  function invoiceEvent(type: string, inv: { customer: string; subscription: string }) {
    return {
      id: `evt_${run}_${++seq}`,
      object: "event",
      created: Math.floor(Date.now() / 1000),
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
});

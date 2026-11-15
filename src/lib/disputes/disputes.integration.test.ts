import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { testPrismaClient } from "@/lib/test-prisma";

const requirePlatformAdmin = vi.fn();
vi.mock("../admin/session", () => ({ requirePlatformAdmin: () => requirePlatformAdmin() }));

const { POST } = await import("@/app/api/webhooks/stripe/route");
const { platformAdminTransaction, storeScoped, storeScopedTransaction } = await import("../db");
const { setStripeProvider } = await import("../stripe");
const { stripeProvider } = await import("../stripe/provider");
const { fakeStripeProvider } = await import("../stripe/fake");
const { setEmailSenderForTests } = await import("../email/send");
const { PushTestSender, setPushSenderForTests } = await import("../push/sender");
const { getStoreOrders } = await import("../order/service");
const { listOpenDisputes } = await import("../admin/disputes");

const hasDb = !!process.env.DATABASE_URL;
const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

describe.skipIf(!hasDb)("card disputes (#539)", () => {
  const run = `dp539-${Date.now()}`;
  const ADMIN = { id: `u_admin_${run}`, email: `ops@${run}.test` };
  let raw: PrismaClient;
  let secret = "";
  let storeA = "";
  let storeB = "";
  let seq = 0;
  const emails: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];
  let sender: InstanceType<typeof PushTestSender>;
  const owner = `u_owner_${run}`;
  const staff = `u_staff_${run}`;

  function disputeEvent(
    type: string,
    d: { id: string; pi: string | null; amount: number; status: string; reason?: string; dueBy?: number | null; fee?: number },
    opts: { id?: string; created?: number } = {},
  ) {
    seq += 1;
    return {
      id: opts.id ?? `evt_${run}_${seq}`,
      object: "event",
      api_version: "2025-09-30.clover",
      created: opts.created ?? Math.floor(Date.now() / 1000),
      type,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: d.id,
          object: "dispute",
          amount: d.amount,
          currency: "usd",
          charge: `ch_${d.id}`,
          payment_intent: d.pi,
          reason: d.reason ?? "product_not_received",
          status: d.status,
          livemode: false,
          is_charge_refundable: false,
          created: 1_763_000_000,
          metadata: {},
          evidence_details: { due_by: d.dueBy === undefined ? 1_764_000_000 : d.dueBy, has_evidence: false, past_due: false, submission_count: 0 },
          balance_transactions: d.fee === undefined ? [] : [{
            id: `txn_${d.id}`,
            object: "balance_transaction",
            amount: -d.amount,
            fee: d.fee,
            net: -(d.amount + d.fee),
            currency: "usd",
            type: "adjustment",
            reporting_category: "dispute",
          }],
        },
      },
    };
  }

  async function deliver(event: object, signature?: string) {
    const payload = JSON.stringify(event);
    return POST(new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": signature ?? Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
    }));
  }

  async function completedOrder(storeId: string, totalCents: number) {
    seq += 1;
    const customer = await storeScoped(storeId).customer.create({ data: { storeId, name: `Dispute ${seq}`, email: `c${seq}@${run}.test` } });
    return storeScoped(storeId).order.create({
      data: {
        storeId,
        number: 500 + seq,
        customerId: customer.id,
        status: "COMPLETED",
        fulfillment: "pickup",
        subtotalCents: totalCents,
        bufferCents: 0,
        totalAuthorizedCents: totalCents,
        totalCents,
        capturedAmountCents: totalCents,
        paymentIntentId: `pi_${run}_${seq}`,
        completedAt: new Date("2026-11-01T12:00:00Z"),
      },
    });
  }

  const disputeRow = (stripeDisputeId: string) =>
    platformAdminTransaction((tx) => tx.paymentDispute.findUnique({ where: { stripeDisputeId } }));

  beforeAll(async () => {
    secret = process.env.STRIPE_WEBHOOK_SECRET?.split(",")[0]?.trim() || "whsec_test_ticket_539";
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
    vi.stubEnv("VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private");
    if (!process.env.STRIPE_SECRET_KEY) vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: `${run}-a`, name: "Dispute A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: `${run}-b`, name: "Dispute B", themePreset: "palm-and-shea" } })).id;
    await raw.user.createMany({
      data: [
        { id: ADMIN.id, name: "Ops", email: ADMIN.email, role: "platform_admin" },
        { id: owner, name: "Owner", email: `owner@${run}.test` },
        { id: staff, name: "Staff", email: `staff@${run}.test` },
      ],
    });
    await storeScoped(storeA).storeMembership.createMany({
      data: [{ storeId: storeA, userId: owner, role: "owner" }, { storeId: storeA, userId: staff, role: "staff" }],
    });
    for (const userId of [owner, staff]) {
      await storeScoped(storeA).pushSubscription.create({
        data: { storeId: storeA, userId, endpoint: `https://fcm.googleapis.com/fcm/send/${userId}`, ...keys },
      });
    }
    setStripeProvider({ ...fakeStripeProvider, verifyWebhookSignature: (input) => stripeProvider.verifyWebhookSignature(input) });
    setEmailSenderForTests({ send: async (m) => (emails.push(m), { id: `email_${emails.length}` }) });
  });

  beforeEach(() => {
    sender = new PushTestSender();
    setPushSenderForTests(sender);
    emails.length = 0;
    requirePlatformAdmin.mockReset();
    requirePlatformAdmin.mockResolvedValue({ user: ADMIN });
  });

  afterAll(async () => {
    setStripeProvider(null);
    setEmailSenderForTests(null);
    setPushSenderForTests(null);
    vi.unstubAllEnvs();
    if (!raw) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.paymentDisputeEvent.deleteMany({ where: { id: { startsWith: `evt_${run}` } } });
      await tx.paymentDispute.deleteMany({ where: { stripeDisputeId: { startsWith: `dp_${run}` } } });
      for (const id of [storeA, storeB]) {
        await tx.order.deleteMany({ where: { storeId: id } });
        await tx.customer.deleteMany({ where: { storeId: id } });
        await tx.pushSubscription.deleteMany({ where: { storeId: id } });
        await tx.storeMembership.deleteMany({ where: { storeId: id } });
        await tx.store.deleteMany({ where: { id } });
      }
    });
    await raw.user.deleteMany({ where: { id: { in: [ADMIN.id, owner, staff] } } });
    await raw.$disconnect();
  });

  it("a signed dispute.created stores the dispute, pushes the owners once and badges the order; a replay changes nothing", async () => {
    const order = await completedOrder(storeA, 4200);
    const created = disputeEvent("charge.dispute.created", { id: `dp_${run}_a`, pi: order.paymentIntentId, amount: 4200, status: "needs_response" });

    expect((await deliver(created, "t=1,v1=forged")).status).toBe(400);
    expect(await disputeRow(`dp_${run}_a`)).toBeNull();

    expect((await deliver(created)).status).toBe(200);
    const row = await disputeRow(`dp_${run}_a`);
    expect(row).toMatchObject({
      storeId: storeA,
      orderId: order.id,
      amountCents: 4200,
      reason: "product_not_received",
      status: "needs_response",
      outcome: null,
      evidenceDueBy: new Date(1_764_000_000 * 1000),
    });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].endpoint).toContain(owner);
    expect(sender.sent[0].message.body).toBe(`A customer disputed order #${order.number}`);

    const inbox = await getStoreOrders(storeA);
    expect(inbox.find((o) => o.id === order.id)?.disputed).toBe(true);

    const before = await disputeRow(`dp_${run}_a`);
    expect((await deliver(created)).status).toBe(200);
    expect(sender.sent).toHaveLength(1);
    expect((await disputeRow(`dp_${run}_a`))!.updatedAt).toEqual(before!.updatedAt);
  });

  it("a run that died before the push pushes on Stripe's retry", async () => {
    const order = await completedOrder(storeA, 1800);
    const created = disputeEvent("charge.dispute.created", { id: `dp_${run}_crash`, pi: order.paymentIntentId, amount: 1800, status: "needs_response" });
    expect((await deliver(created)).status).toBe(200);
    await platformAdminTransaction((tx) => tx.paymentDispute.update({ where: { stripeDisputeId: `dp_${run}_crash` }, data: { notifiedAt: null } }));
    sender = new PushTestSender();
    setPushSenderForTests(sender);
    expect((await deliver(created)).status).toBe(200);
    expect(sender.sent.filter((s) => s.endpoint.includes(owner))).toHaveLength(1);
    expect((await disputeRow(`dp_${run}_crash`))!.notifiedAt).not.toBeNull();
  });

  it("an older event arriving late is skipped; closed records the outcome and leaves the queue", async () => {
    const order = await completedOrder(storeA, 3000);
    const id = `dp_${run}_late`;
    const now = Math.floor(Date.now() / 1000);
    await deliver(disputeEvent("charge.dispute.created", { id, pi: order.paymentIntentId, amount: 3000, status: "needs_response" }, { created: now }));
    await deliver(disputeEvent("charge.dispute.updated", { id, pi: order.paymentIntentId, amount: 3000, status: "under_review" }, { created: now + 10 }));
    expect((await deliver(disputeEvent("charge.dispute.updated", { id, pi: order.paymentIntentId, amount: 3000, status: "needs_response" }, { created: now + 5 }))).status).toBe(200);
    expect((await disputeRow(id))!.status).toBe("under_review");

    await deliver(disputeEvent("charge.dispute.closed", { id, pi: order.paymentIntentId, amount: 3000, status: "lost" }, { created: now + 20 }));
    // A same-second update cannot reopen a closed dispute.
    await deliver(disputeEvent("charge.dispute.updated", { id, pi: order.paymentIntentId, amount: 3000, status: "under_review" }, { created: now + 20 }));
    expect(await disputeRow(id)).toMatchObject({ status: "lost", outcome: "lost" });
    expect((await listOpenDisputes()).rows.map((r) => r.stripeDisputeId)).not.toContain(id);
  });

  it("funds withdrawn records Stripe's fee on a partial dispute; the platform absorbs it and the order's money is untouched", async () => {
    const order = await completedOrder(storeA, 5000);
    const id = `dp_${run}_partial`;
    await deliver(disputeEvent("charge.dispute.created", { id, pi: order.paymentIntentId, amount: 1250, status: "needs_response" }));
    expect((await deliver(disputeEvent("charge.dispute.funds_withdrawn", { id, pi: order.paymentIntentId, amount: 1250, status: "needs_response", fee: 1500 }))).status).toBe(200);
    expect(await disputeRow(id)).toMatchObject({ amountCents: 1250, feeCents: 1500 });
    const after = await storeScoped(storeA).order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({ status: "COMPLETED", capturedAmountCents: 5000, totalCents: 5000 });
    expect(await storeScoped(storeA).refundRequest.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("a dispute whose charge maps to no order is stored with no order and alerts the platform once", async () => {
    const id = `dp_${run}_orphan`;
    const created = disputeEvent("charge.dispute.created", { id, pi: `pi_${run}_unknown`, amount: 999, status: "needs_response" });
    expect((await deliver(created)).status).toBe(200);
    expect(await disputeRow(id)).toMatchObject({ storeId: null, orderId: null, amountCents: 999 });
    const mine = emails.filter((e) => e.to === ADMIN.email);
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/no matching order/i);
    expect(sender.sent).toHaveLength(0);

    await deliver(created);
    expect(emails.filter((e) => e.to === ADMIN.email)).toHaveLength(1);
    const queued = (await listOpenDisputes()).rows.find((r) => r.stripeDisputeId === id);
    expect(queued).toMatchObject({ orderNumber: null, storeName: null });
  });

  it("RLS: a store reads only its own disputes and cannot write one", async () => {
    const order = await completedOrder(storeA, 2000);
    const id = `dp_${run}_rls`;
    await deliver(disputeEvent("charge.dispute.created", { id, pi: order.paymentIntentId, amount: 2000, status: "needs_response" }));
    const own = await storeScopedTransaction(storeA, (tx) => tx.paymentDispute.findMany({ where: { stripeDisputeId: id } }));
    expect(own).toHaveLength(1);
    const other = await storeScopedTransaction(storeB, (tx) => tx.paymentDispute.findMany({ where: { stripeDisputeId: { startsWith: `dp_${run}` } } }));
    expect(other).toEqual([]);
    expect((await getStoreOrders(storeB)).some((o) => o.id === order.id)).toBe(false);
    await expect(storeScopedTransaction(storeB, (tx) => tx.paymentDispute.create({
      data: { storeId: storeB, stripeDisputeId: `dp_${run}_forged`, chargeId: "ch_x", amountCents: 1, currency: "usd", reason: "general", status: "needs_response", lastEventAt: new Date() },
    }))).rejects.toThrow();
  });

  it("the platform queue lists open disputes by evidence due date with a Stripe Dashboard link, admins only", async () => {
    const first = await completedOrder(storeB, 1000);
    const second = await completedOrder(storeB, 1000);
    await deliver(disputeEvent("charge.dispute.created", { id: `dp_${run}_due2`, pi: second.paymentIntentId, amount: 1000, status: "needs_response", dueBy: 1_700_000_200 }));
    await deliver(disputeEvent("charge.dispute.created", { id: `dp_${run}_due1`, pi: first.paymentIntentId, amount: 1000, status: "warning_needs_response", dueBy: 1_700_000_100 }));
    const rows = (await listOpenDisputes()).rows.filter((r) => r.stripeDisputeId.startsWith(`dp_${run}_due`));
    expect(rows.map((r) => r.stripeDisputeId)).toEqual([`dp_${run}_due1`, `dp_${run}_due2`]);
    expect(rows[0]).toMatchObject({ orderNumber: first.number, storeName: "Dispute B", dashboardUrl: `https://dashboard.stripe.com/test/disputes/dp_${run}_due1` });

    requirePlatformAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(listOpenDisputes()).rejects.toThrow("NEXT_REDIRECT");
  });
});

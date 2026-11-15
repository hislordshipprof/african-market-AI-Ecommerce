import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { testPrismaClient } from "@/lib/test-prisma";
import { POST } from "@/app/api/webhooks/stripe/route";
import { platformAdminTransaction, storeScoped } from "../db";
import { setStripeProvider } from "../stripe";
import { stripeProvider } from "../stripe/provider";
import { sandboxConnectedAccountId } from "../stripe/test-sandbox-account";
import { liveSandbox, providerSandbox } from "../test-live-provider";
import { setEmailSenderForTests } from "../email/send";

const run = liveSandbox && !!process.env.STRIPE_SECRET_KEY && !!process.env.DATABASE_URL;
const sandbox = providerSandbox("Stripe");

/**
 * A real sandbox dispute (#539): a destination charge paid with Stripe's `pm_card_createDispute` opens a dispute on
 * the platform. Stripe's own charge.dispute.created event is read back, signed with the test secret (Stripe cannot
 * reach a lane) and delivered to the webhook, so the stored row is checked against Stripe's real object.
 */
describe.skipIf(!run)("card disputes against the Stripe sandbox (#539)", () => {
  const tag = `dp539-sbx-${Date.now()}`;
  let stripe: Stripe;
  let raw: PrismaClient;
  let storeId = "";
  let secret = "";

  beforeAll(sandbox.hook(async () => {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    secret = "whsec_test_sandbox_539";
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
    setStripeProvider(stripeProvider);
    setEmailSenderForTests({ send: async () => ({ id: "email_sandbox" }) });
    raw = testPrismaClient();
    storeId = (await raw.store.create({ data: { slug: tag, name: "Dispute sandbox", themePreset: "palm-and-shea" } })).id;
  }));

  afterAll(async () => {
    setStripeProvider(null);
    setEmailSenderForTests(null);
    vi.unstubAllEnvs();
    if (!raw || !storeId) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.paymentDispute.deleteMany({ where: { storeId } });
      await tx.order.deleteMany({ where: { storeId } });
      await tx.customer.deleteMany({ where: { storeId } });
      await tx.store.deleteMany({ where: { id: storeId } });
    });
    await raw.$disconnect();
  });

  it("Stripe's dispute.created for a destination charge is stored against its order, and funds_withdrawn records the fee", sandbox.test(async () => {
    const destination = await sandboxConnectedAccountId(stripe);
    const pi = await stripe.paymentIntents.create({
      amount: 2350,
      currency: "usd",
      payment_method: "pm_card_createDispute",
      confirm: true,
      on_behalf_of: destination,
      transfer_data: { destination },
      application_fee_amount: 100,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { sandboxTest: tag },
    });
    expect(pi.status).toBe("succeeded");

    const customer = await storeScoped(storeId).customer.create({ data: { storeId, name: "Sandbox", email: `${tag}@example.com` } });
    const order = await storeScoped(storeId).order.create({
      data: {
        storeId, number: 1, customerId: customer.id, status: "COMPLETED", fulfillment: "pickup",
        subtotalCents: 2350, bufferCents: 0, totalAuthorizedCents: 2350, totalCents: 2350, capturedAmountCents: 2350, paymentIntentId: pi.id,
      },
    });

    const deliver = async (event: Stripe.Event) => {
      const payload = JSON.stringify(event);
      return POST(new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
      }));
    };
    const event = await waitForDisputeEvent(stripe, "charge.dispute.created", pi.id);
    expect((await deliver(event)).status).toBe(200);

    const dispute = event.data.object as Stripe.Dispute;
    const row = await platformAdminTransaction((tx) => tx.paymentDispute.findUnique({ where: { stripeDisputeId: dispute.id } }));
    expect(row).toMatchObject({
      storeId,
      orderId: order.id,
      amountCents: dispute.amount,
      reason: dispute.reason,
      status: dispute.status,
      livemode: false,
    });
    expect(row!.evidenceDueBy?.getTime()).toBe((dispute.evidence_details.due_by ?? 0) * 1000);

    // Stripe debits the disputed amount and its fee from the platform balance on a destination charge.
    const withdrawn = await waitForDisputeEvent(stripe, "charge.dispute.funds_withdrawn", pi.id);
    expect((await deliver(withdrawn)).status).toBe(200);
    const fee = (withdrawn.data.object as Stripe.Dispute).balance_transactions.reduce((sum, t) => sum + t.fee, 0);
    expect(fee).toBeGreaterThan(0);
    const after = await platformAdminTransaction((tx) => tx.paymentDispute.findUniqueOrThrow({ where: { stripeDisputeId: dispute.id } }));
    expect(after.feeCents).toBe(fee);
    console.log(JSON.stringify({ sandboxDispute: dispute.id, status: dispute.status, reason: dispute.reason, amount: dispute.amount, dueBy: dispute.evidence_details.due_by, feeCents: after.feeCents }));
  }), 120_000);
});

async function waitForDisputeEvent(stripe: Stripe, type: "charge.dispute.created" | "charge.dispute.funds_withdrawn", paymentIntentId: string): Promise<Stripe.Event> {
  const deadline = Date.now() + 90_000;
  const since = Math.floor(Date.now() / 1000) - 300;
  while (Date.now() < deadline) {
    const events = await stripe.events.list({ type, limit: 50, created: { gte: since } });
    const match = events.data.find((e) => (e.data.object as Stripe.Dispute).payment_intent === paymentIntentId);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`${type} for ${paymentIntentId} did not appear`);
}

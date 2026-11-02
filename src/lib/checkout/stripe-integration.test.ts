import { describe, it, expect, afterAll } from "vitest";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const hasKey = !!process.env.STRIPE_SECRET_KEY;
const hasDb = !!process.env.DATABASE_URL;

const piToCleanup: string[] = [];

afterAll(async () => {
  if (!hasKey || piToCleanup.length === 0) return;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  for (const id of piToCleanup) {
    try {
      await stripe.paymentIntents.cancel(id);
    } catch {
      // best-effort cleanup
    }
  }
});

describe.skipIf(!hasKey || !hasDb)(
  "Stripe checkout integration (test mode)",
  () => {
    let storeId: string;
    let stripeAccountId: string;

    it(
      "finds a charges-enabled store",
      { timeout: 15_000 },
      async () => {
        const adapter = new PrismaPg(process.env.DATABASE_URL!);
        const prisma = new PrismaClient({ adapter });
        const store = await prisma.store.findFirst({
          where: {
            stripeOnboardingStatus: "complete",
            stripeAccountId: { not: null },
          },
        });
        await prisma.$disconnect();
        expect(store).toBeTruthy();
        storeId = store!.id;
        stripeAccountId = store!.stripeAccountId!;
      },
    );

    it(
      "creates a PaymentIntent with manual capture and destination charge",
      { timeout: 15_000 },
      async () => {
        if (!stripeAccountId) return;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        const pi = await stripe.paymentIntents.create({
          amount: 5000,
          currency: "usd",
          capture_method: "manual",
          on_behalf_of: stripeAccountId,
          transfer_data: { destination: stripeAccountId },
        });
        piToCleanup.push(pi.id);

        expect(pi.id).toMatch(/^pi_/);
        expect(pi.status).toBe("requires_payment_method");
        expect(pi.capture_method).toBe("manual");
        expect(pi.client_secret).toBeTruthy();
        expect(pi.amount).toBe(5000);
        expect(pi.transfer_data?.destination).toBe(stripeAccountId);
      },
    );

    it(
      "buffer formula: 10% capped at $20 for various amounts",
      async () => {
        const cases = [
          { subtotal: 1000, expected: 100 },
          { subtotal: 5000, expected: 500 },
          { subtotal: 20000, expected: 2000 },
          { subtotal: 25000, expected: 2000 },
          { subtotal: 50000, expected: 2000 },
        ];
        for (const { subtotal, expected } of cases) {
          const buffer = Math.min(Math.round(subtotal * 0.1), 2000);
          expect(buffer).toBe(expected);
        }
      },
    );

    it(
      "rejects PaymentIntent with amount below Stripe minimum",
      { timeout: 15_000 },
      async () => {
        if (!stripeAccountId) return;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
        await expect(
          stripe.paymentIntents.create({
            amount: 10,
            currency: "usd",
            capture_method: "manual",
            on_behalf_of: stripeAccountId,
            transfer_data: { destination: stripeAccountId },
          }),
        ).rejects.toThrow();
      },
    );
  },
);

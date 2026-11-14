import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authPrisma, customerScoped } from "../db";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { CUSTOMER_AMBIGUOUS, platformCustomerIdempotencyKey } from "./consent";
import { ensureStripeCustomer } from "./stripe-customer";

const hasDb = Boolean(process.env.DATABASE_URL);
const run = `t248-repair-${Date.now()}`;

describe.skipIf(!hasDb)("stripe customer repair", () => {
  // Only this run's ids: other suites share the database and run in parallel workers.
  const userIds: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    resetFakeCheckoutPayments();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await authPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    resetFakeCheckoutPayments();
  });

  async function user(suffix: string): Promise<string> {
    const userId = `user-${run}-${suffix}`;
    userIds.push(userId);
    await authPrisma.user.create({ data: { id: userId, name: "Ada", email: `${userId}@example.test` } });
    return userId;
  }

  it("does not store a cached deleted customer as ready", async () => {
    const userId = await user("live");
    const key = platformCustomerIdempotencyKey(userId, "cus_deleted");
    const cached = await getCheckoutPayments().createCustomer({ metadata: { user_id: userId } }, key);
    await getCheckoutPayments().deleteCustomer(cached.id);
    await customerScoped(userId).platformCustomerProfile.create({
      data: {
        userId,
        stripeCustomerId: cached.id,
        stripeCustomerStatus: "pending",
        stripeCustomerIdempotencyKey: key,
        stripeCustomerAttemptedAt: new Date(),
      },
    });

    const repaired = await ensureStripeCustomer(userId);
    expect(repaired).not.toBe(cached.id);
    const live = await getCheckoutPayments().retrieveCustomer(repaired);
    expect(live.deleted).toBe(false);
    const row = await customerScoped(userId).platformCustomerProfile.findUnique({ where: { userId } });
    expect(row?.stripeCustomerStatus).toBe("ready");
    expect(row?.stripeCustomerId).toBe(repaired);
  });

  it("fails closed when a pending repair is older than the idempotency window and the customer is gone", async () => {
    const userId = await user("stale");
    const key = platformCustomerIdempotencyKey(userId, "cus_stale");
    const cached = await getCheckoutPayments().createCustomer({ metadata: { user_id: userId } }, key);
    await getCheckoutPayments().deleteCustomer(cached.id);
    await customerScoped(userId).platformCustomerProfile.create({
      data: {
        userId,
        stripeCustomerId: cached.id,
        stripeCustomerStatus: "pending",
        stripeCustomerIdempotencyKey: key,
        stripeCustomerAttemptedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });

    await expect(ensureStripeCustomer(userId)).rejects.toThrow(CUSTOMER_AMBIGUOUS);
    const row = await customerScoped(userId).platformCustomerProfile.findUnique({ where: { userId } });
    expect(row?.stripeCustomerStatus).toBe("pending");
    expect(row?.stripeCustomerId).toBe(cached.id);
  });
});

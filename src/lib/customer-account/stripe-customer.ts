import { randomUUID } from "node:crypto";
import { customerScoped, customerScopedTransaction, lockCustomerAccount, lockCustomerProfileRow } from "../db";
import {
  CARDS_UNAVAILABLE,
  CUSTOMER_AMBIGUOUS,
  idempotencyWindowMs,
  platformCustomerIdempotencyKey,
} from "./consent";
import {
  checkoutPaymentsUseFake,
  getCheckoutPayments,
  type CheckoutProviderError,
} from "../stripe/checkout-payments";

export const customerAccountTestHooks: {
  beforePersistStripeCustomer: (() => Promise<void>) | null;
} = {
  beforePersistStripeCustomer: null,
};

function providerError(error: unknown): { type: string; code?: string; statusCode?: number; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const value = error as Partial<CheckoutProviderError> & { message?: string; raw?: { code?: string } };
  return {
    type: value.type || value.name || "",
    code: value.code || value.raw?.code,
    statusCode: value.statusCode,
    message: value.message || "",
  };
}

function isMissing(error: unknown): boolean {
  const parsed = providerError(error);
  if (!parsed) return false;
  return parsed.code === "resource_missing" || parsed.statusCode === 404 || parsed.message.includes("No such customer");
}

function isIdempotency(error: unknown): boolean {
  const parsed = providerError(error);
  return parsed?.type === "StripeIdempotencyError";
}

function isAmbiguous(error: unknown): boolean {
  const parsed = providerError(error);
  if (!parsed) return false;
  if (parsed.type === "StripeIdempotencyError" || parsed.type === "StripeInvalidRequestError") return false;
  return (parsed.statusCode ?? 0) >= 500 || parsed.statusCode === 408 || parsed.code === "timeout" || parsed.type === "StripeConnectionError" || parsed.type === "StripeAPIError";
}

async function lockProfile(userId: string) {
  return customerScopedTransaction(userId, async (tx) => {
    await lockCustomerProfileRow(tx, userId);
    return tx.platformCustomerProfile.findUnique({ where: { userId } });
  });
}

function assertStripeConfigured(): void {
  if (checkoutPaymentsUseFake()) return;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error(CARDS_UNAVAILABLE);
  }
}

async function runPersistHook(): Promise<void> {
  if (process.env.NODE_ENV === "test" && customerAccountTestHooks.beforePersistStripeCustomer) {
    await customerAccountTestHooks.beforePersistStripeCustomer();
  }
}

async function customerIsLive(id: string): Promise<boolean> {
  try {
    const found = await getCheckoutPayments().retrieveCustomer(id);
    return !found.deleted;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function createCustomerOnce(userId: string, key: string): Promise<{ id: string }> {
  const payments = getCheckoutPayments();
  try {
    return await payments.createCustomer({ metadata: { user_id: userId } }, key);
  } catch (error) {
    if (isIdempotency(error)) return payments.createCustomer({ metadata: { user_id: userId } }, key);
    if (isAmbiguous(error)) throw new Error(CUSTOMER_AMBIGUOUS);
    throw error;
  }
}

async function createLiveCustomer(userId: string, key: string): Promise<{ id: string; key: string }> {
  let currentKey = key;
  let created = await createCustomerOnce(userId, currentKey);
  if (await customerIsLive(created.id)) return { id: created.id, key: currentKey };
  currentKey = `${key}-r${randomUUID()}`;
  await customerScopedTransaction(userId, async (tx) => {
    await lockCustomerAccount(tx, userId);
    await tx.platformCustomerProfile.update({
      where: { userId },
      data: {
        stripeCustomerStatus: "pending",
        stripeCustomerIdempotencyKey: currentKey,
        stripeCustomerAttemptedAt: new Date(),
      },
    });
  });
  created = await createCustomerOnce(userId, currentKey);
  if (!(await customerIsLive(created.id))) throw new Error(CUSTOMER_AMBIGUOUS);
  return { id: created.id, key: currentKey };
}

export async function ensureStripeCustomer(userId: string): Promise<string> {
  assertStripeConfigured();
  const payments = getCheckoutPayments();
  const row = await lockProfile(userId);
  if (!row) throw new Error(CUSTOMER_AMBIGUOUS);

  if (row.stripeCustomerStatus === "ready" && row.stripeCustomerId) {
    try {
      const found = await payments.retrieveCustomer(row.stripeCustomerId);
      if (!found.deleted) return row.stripeCustomerId;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return replaceCustomer(userId, row.stripeCustomerId);
  }

  if (row.stripeCustomerStatus === "pending" && row.stripeCustomerAttemptedAt) {
    const age = Date.now() - row.stripeCustomerAttemptedAt.getTime();
    if (age > idempotencyWindowMs()) {
      const live = row.stripeCustomerId ? await customerIsLive(row.stripeCustomerId) : false;
      if (!live) throw new Error(CUSTOMER_AMBIGUOUS);
    }
  }

  const key = row.stripeCustomerIdempotencyKey && row.stripeCustomerStatus === "pending"
    ? row.stripeCustomerIdempotencyKey
    : platformCustomerIdempotencyKey(userId, row.stripeCustomerId);

  if (row.stripeCustomerStatus !== "pending" || row.stripeCustomerIdempotencyKey !== key) {
    await customerScopedTransaction(userId, async (tx) => {
      await lockCustomerAccount(tx, userId);
      const current = await tx.platformCustomerProfile.findUnique({ where: { userId } });
      if (current?.stripeCustomerStatus === "ready" && current.stripeCustomerId) return;
      await tx.platformCustomerProfile.update({
        where: { userId },
        data: {
          stripeCustomerStatus: "pending",
          stripeCustomerIdempotencyKey: key,
          stripeCustomerAttemptedAt: new Date(),
        },
      });
    });
  }

  const created = await createLiveCustomer(userId, key);

  await runPersistHook();
  if (!(await customerIsLive(created.id))) throw new Error(CUSTOMER_AMBIGUOUS);

  return customerScopedTransaction(userId, async (tx) => {
    await lockCustomerAccount(tx, userId);
    const current = await tx.platformCustomerProfile.findUnique({ where: { userId } });
    if (
      current?.stripeCustomerStatus === "ready" &&
      current.stripeCustomerId &&
      current.stripeCustomerId !== created.id
    ) {
      return current.stripeCustomerId;
    }
    await tx.platformCustomerProfile.update({
      where: { userId },
      data: {
        stripeCustomerId: created.id,
        stripeCustomerStatus: "ready",
        stripeCustomerIdempotencyKey: created.key,
      },
    });
    return created.id;
  });
}

async function replaceCustomer(userId: string, oldId: string): Promise<string> {
  const key = platformCustomerIdempotencyKey(userId, oldId);
  await customerScopedTransaction(userId, async (tx) => {
    await lockCustomerAccount(tx, userId);
    const current = await tx.platformCustomerProfile.findUnique({ where: { userId } });
    if (!current || current.stripeCustomerId !== oldId) return;
    await tx.platformCustomerProfile.update({
      where: { userId },
      data: {
        stripeCustomerStatus: "pending",
        stripeCustomerIdempotencyKey: key,
        stripeCustomerAttemptedAt: new Date(),
      },
    });
  });
  const created = await createLiveCustomer(userId, key);
  if (!(await customerIsLive(created.id))) throw new Error(CUSTOMER_AMBIGUOUS);
  return customerScopedTransaction(userId, async (tx) => {
    await lockCustomerAccount(tx, userId);
    const current = await tx.platformCustomerProfile.findUnique({ where: { userId } });
    if (current?.stripeCustomerStatus === "ready" && current.stripeCustomerId && current.stripeCustomerId !== oldId && current.stripeCustomerId !== created.id) {
      return current.stripeCustomerId;
    }
    await tx.platformCustomerProfile.update({
      where: { userId },
      data: {
        stripeCustomerId: created.id,
        stripeCustomerStatus: "ready",
        stripeCustomerIdempotencyKey: created.key,
      },
    });
    return created.id;
  });
}

export async function readStripeCustomerId(userId: string): Promise<string | null> {
  const row = await customerScoped(userId).platformCustomerProfile.findUnique({ where: { userId } });
  return row?.stripeCustomerStatus === "ready" ? row.stripeCustomerId : null;
}

import type { PrismaClient } from "@prisma/client";
import { readDatabaseNow } from "../db";

export class AssistantCheckoutInProgressError extends Error {
  readonly code = "assistant_checkout_in_progress";

  constructor() {
    super("An assistant checkout is already paying for this basket.");
    this.name = "AssistantCheckoutInProgressError";
  }
}

/** An expired live attempt still has a PaymentIntent. The caller releases it outside the lock. */
export class AssistantAttemptExpiredError extends Error {
  readonly code = "assistant_attempt_expired";

  constructor(readonly attemptId: string, readonly paymentIntentId: string) {
    super("An assistant checkout on this basket has expired.");
    this.name = "AssistantAttemptExpiredError";
  }
}

type GuardTx = Pick<PrismaClient, "assistantCheckoutAttempt" | "$queryRaw">;

const LIVE = ["reserved", "awaiting_payment"] as const;

/**
 * The single live attempt on a cart.
 * The owning attempt is returned. An unexpired stranger is refused.
 * An expired attempt with no PaymentIntent is superseded here.
 * An expired attempt that still has one throws so the caller can read the provider outside the lock.
 */
export async function assertAssistantAttempt(
  tx: GuardTx,
  cartId: string,
  assistantAttemptId?: string | null,
) {
  const owner = await tx.assistantCheckoutAttempt.findFirst({
    where: { cartId, status: { in: [...LIVE] } },
    orderBy: { createdAt: "asc" },
  });
  if (!owner) return null;
  if (owner.id === assistantAttemptId) return owner;
  const now = await readDatabaseNow(tx);
  if (owner.expiresAt.getTime() > now.getTime()) throw new AssistantCheckoutInProgressError();
  if (!owner.paymentIntentId) {
    await tx.assistantCheckoutAttempt.updateMany({
      where: { id: owner.id, status: { in: [...LIVE] }, paymentIntentId: null },
      data: { status: "superseded" },
    });
    return null;
  }
  throw new AssistantAttemptExpiredError(owner.id, owner.paymentIntentId);
}

import type { PrismaClient } from "@prisma/client";

export class AssistantCheckoutInProgressError extends Error {
  readonly code = "assistant_checkout_in_progress";

  constructor() {
    super("An assistant checkout is already paying for this basket.");
    this.name = "AssistantCheckoutInProgressError";
  }
}

type GuardTx = Pick<PrismaClient, "assistantCheckoutAttempt">;

/** A reserved assistant attempt owns the cart's payment intent until it finishes or is released. */
export async function assertAssistantAttempt(
  tx: GuardTx,
  cartId: string,
  assistantAttemptId?: string | null,
) {
  const owner = await tx.assistantCheckoutAttempt.findFirst({
    where: { cartId, status: { in: ["reserved", "awaiting_payment"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!owner) return null;
  if (owner.id !== assistantAttemptId) throw new AssistantCheckoutInProgressError();
  return owner;
}

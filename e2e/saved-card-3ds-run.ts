import type { Prisma, PrismaClient } from "@prisma/client";

/** One run of the real-Stripe 3DS spec. The store is shared (it owns the one ready sandbox account); the email and listing are the run's own. */
export type SavedCard3dsRun = { storeId: string; email: string; listingId: string };

export type SandboxCleanup = {
  cancelHold: (paymentIntentId: string) => Promise<unknown>;
  deleteCustomer: (stripeCustomerId: string) => Promise<unknown>;
};

/**
 * Finds what the run made from its unique email and listing, so a run that failed part-way is cleaned
 * the same as one that passed, then releases its holds and deletes only those rows, by id.
 */
export async function cleanupSavedCard3dsRun(prisma: PrismaClient, run: SavedCard3dsRun, stripe: SandboxCleanup): Promise<void> {
  const { storeId, email, listingId } = run;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const profile = user
    ? await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
        return tx.platformCustomerProfile.findUnique({ where: { userId: user.id }, select: { stripeCustomerId: true } });
      })
    : null;
  const owned = await asPlatformAdmin(prisma, async (tx) => {
    const customers = await tx.customer.findMany({
      where: { storeId, OR: [{ email }, ...(user ? [{ userId: user.id }] : [])] },
      select: { id: true },
    });
    const customerIds = customers.map((customer) => customer.id);
    const orders = await tx.order.findMany({
      where: { storeId, customerId: { in: customerIds } },
      select: { id: true, paymentIntentId: true, sourceCartId: true },
    });
    const sourceCartIds = orders.flatMap((order) => (order.sourceCartId ? [order.sourceCartId] : []));
    const carts = await tx.cart.findMany({
      where: {
        storeId,
        OR: [{ customerId: { in: customerIds } }, { id: { in: sourceCartIds } }, ...(user ? [{ userId: user.id }] : [])],
      },
      select: { id: true, paymentIntentId: true },
    });
    return { customerIds, orders, carts };
  });

  const intents = new Set([...owned.orders, ...owned.carts].flatMap((row) => (row.paymentIntentId ? [row.paymentIntentId] : [])));
  // An intent the run already captured or cancelled refuses a second cancel; that is the state cleanup wants.
  for (const id of intents) await stripe.cancelHold(id).catch(() => undefined);
  if (profile?.stripeCustomerId) await stripe.deleteCustomer(profile.stripeCustomerId).catch(() => undefined);

  await asPlatformAdmin(prisma, async (tx) => {
    await tx.order.deleteMany({ where: { id: { in: owned.orders.map((order) => order.id) } } });
    await tx.cart.deleteMany({ where: { id: { in: owned.carts.map((cart) => cart.id) } } });
    await tx.customer.deleteMany({ where: { id: { in: owned.customerIds } } });
    await tx.listingVariant.deleteMany({ where: { listingId } });
    await tx.listing.deleteMany({ where: { id: listingId } });
  });
  if (user) await prisma.user.delete({ where: { id: user.id } });
}

function asPlatformAdmin<T>(prisma: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return work(tx);
  });
}

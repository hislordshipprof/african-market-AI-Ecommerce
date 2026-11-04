import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";

async function withMama<T>(run: (tx: import("@prisma/client").Prisma.TransactionClient, storeId: string) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    const store = await prisma.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      return run(tx, store.id);
    });
  } finally {
    await prisma.$disconnect();
  }
}

export async function insertInboxOrder(input: {
  number: number;
  status: string;
  capturedAmountCents: number | null;
}): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: input.number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listing = await tx.listing.findFirstOrThrow({
      where: { storeId },
      include: { variants: { take: 1 } },
    });
    const variant = listing.variants[0];
    if (!variant) throw new Error("mama-ngozi has no listing variant");
    const amount = input.capturedAmountCents ?? 1000;
    await tx.order.create({
      data: {
        storeId,
        number: input.number,
        customerId: customer.id,
        status: input.status,
        fulfillment: "pickup",
        subtotalCents: amount,
        bufferCents: 100,
        totalAuthorizedCents: amount + 100,
        totalCents: amount,
        capturedAmountCents: input.capturedAmountCents,
        paymentIntentId: `pi_e2e_${input.number}_${Date.now()}`,
        lines: {
          create: {
            listingVariantId: variant.id,
            qtyOrdered: 1,
            unitPriceCents: amount,
          },
        },
      },
    });
  });
}

export async function setInboxOrderStatus(number: number, status: string): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.updateMany({ where: { storeId, number }, data: { status } });
  });
}

export async function seedCaptureLabel(number: number): Promise<string> {
  return withMama(async (tx, storeId) => {
    const order = await tx.order.findFirstOrThrow({
      where: { storeId, number },
      include: { lines: true },
    });
    const cents = order.lines.reduce(
      (sum, line) => sum + line.unitPriceCents * line.qtyOrdered,
      0,
    ) + order.tipCents + order.deliveryFeeCents;
    return `$${(cents / 100).toFixed(2)}`;
  });
}

export async function deleteInboxOrder(number: number): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number } });
  });
}

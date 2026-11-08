import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../src/lib/system-actor";

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
  refundId?: string;
  seedHold?: boolean;
  notes?: string | null;
  platformResolved?: boolean;
}): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: input.number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listing = await tx.listing.findFirstOrThrow({
      where: { storeId, variants: { some: {} } },
      include: { variants: { take: 1 } },
    });
    const variant = listing.variants[0];
    if (!variant) throw new Error("mama-ngozi has no listing variant");
    const amount = input.capturedAmountCents ?? 1000;
    const order = await tx.order.create({
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
        refundId: input.refundId ?? null,
        notes: input.notes ?? null,
        paymentIntentId: input.seedHold
          ? `pi_seed_e2e_${input.number}`
          : `pi_e2e_${input.number}_${Date.now()}`,
        lines: {
          create: {
            listingVariantId: variant.id,
            qtyOrdered: 1,
            unitPriceCents: amount,
          },
        },
      },
    });
    if (input.platformResolved) {
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "refund_resolved_manually",
          entityType: "order",
          entityId: order.id,
          after: { note: input.notes ?? "", alert: "store" },
        },
      });
    }
  });
}

/** A completed guest order with its own guest Customer, the way checkout stores it (lowercased email). */
export async function insertGuestOrder(input: {
  email: string;
  name: string;
  phone: string;
}): Promise<{ orderId: string; guestCustomerId: string; number: number }> {
  return withMama(async (tx, storeId) => {
    await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId} FOR UPDATE`;
    const max = await tx.order.aggregate({ where: { storeId }, _max: { number: true } });
    const number = (max._max.number ?? 0) + 1;
    const listing = await tx.listing.findFirstOrThrow({
      where: { storeId, variants: { some: {} } },
      include: { variants: { take: 1 } },
    });
    const guest = await tx.customer.create({
      data: { storeId, name: input.name, email: input.email.trim().toLowerCase(), phone: input.phone },
    });
    const order = await tx.order.create({
      data: {
        storeId,
        number,
        customerId: guest.id,
        status: "COMPLETED",
        fulfillment: "pickup",
        subtotalCents: 1250,
        bufferCents: 125,
        totalAuthorizedCents: 1375,
        capturedAmountCents: 1250,
        lines: {
          create: { listingVariantId: listing.variants[0].id, qtyOrdered: 1, unitPriceCents: 1250 },
        },
      },
    });
    return { orderId: order.id, guestCustomerId: guest.id, number };
  });
}

export async function deleteGuestOrder(input: { orderId: string; guestCustomerId: string }): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, id: input.orderId } });
    await tx.customer.deleteMany({ where: { storeId, id: input.guestCustomerId } });
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

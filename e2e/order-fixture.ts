import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../src/lib/system-actor";

const E2E_COUPON = "E2ESAVE";

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
  /** Goods discount from a store coupon (#557); subtotal stays the goods before it. */
  discountCents?: number;
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
    const discountCents = input.discountCents ?? 0;
    const coupon = discountCents > 0
      ? await tx.storeCoupon.upsert({
          where: { storeId_code: { storeId, code: E2E_COUPON } },
          update: {},
          create: { storeId, code: E2E_COUPON, kind: "fixed", amountOffCents: discountCents, startsAt: new Date("2026-01-01T00:00:00Z"), createdById: SYSTEM_ACTOR_ID },
        })
      : null;
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
        discountCents,
        couponId: coupon?.id ?? null,
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
}): Promise<{ orderId: string; guestCustomerId: string; number: number; lineName: string }> {
  return withMama(async (tx, storeId) => {
    await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId} FOR UPDATE`;
    const max = await tx.order.aggregate({ where: { storeId }, _max: { number: true } });
    const number = (max._max.number ?? 0) + 1;
    const listing = await tx.listing.findFirstOrThrow({
      where: { storeId, variants: { some: {} } },
      include: { variants: { take: 1 }, masterProduct: { select: { name: true } } },
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
    const productName = listing.customName ?? listing.masterProduct?.name ?? "";
    const lineName = [productName, listing.variants[0].label].filter(Boolean).join(" · ");
    return { orderId: order.id, guestCustomerId: guest.id, number, lineName };
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
    await tx.storeCoupon.deleteMany({ where: { storeId, code: E2E_COUPON, orders: { none: {} } } });
  });
}

/** A courier order packing (#562): ready time set, courier assigned with a pickup ETA. Deliveries go with the order. */
export async function insertCourierPackingOrder(number: number, readyAt: Date): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listing = await tx.listing.findFirstOrThrow({ where: { storeId, variants: { some: {} } }, include: { variants: { take: 1 } } });
    const order = await tx.order.create({
      data: {
        storeId, number, customerId: customer.id, status: "PICKING", fulfillment: "courier",
        subtotalCents: 1000, bufferCents: 100, deliveryFeeCents: 799, totalAuthorizedCents: 1899, totalCents: 1799,
        paymentIntentId: `pi_e2e_${number}_${Date.now()}`,
        pickingStartedAt: new Date(readyAt.getTime() - 18 * 60_000), readyEstimateAt: readyAt,
        lines: { create: { listingVariantId: listing.variants[0].id, qtyOrdered: 1, unitPriceCents: 1000 } },
      },
    });
    await tx.delivery.create({
      data: {
        storeId, orderId: order.id, provider: "doordash", externalId: `e2e-${number}-${Date.now()}`, status: "courier_assigned",
        quoteFeeCents: 799, pickupReadyAt: readyAt,
        courierJson: { name: "Sam", vehicle: "Toyota Corolla", pickupEta: new Date(readyAt.getTime() - 2 * 60_000).toISOString(), dropoffEta: null },
      },
    });
  });
}

/**
 * Ready store-delivery orders in one slot (#566), and optionally a live driver route holding them, opened by `token`.
 * Returns the order ids nearest-first. Remove with deleteDriverRouteOrders.
 */
export async function insertDriverRouteOrders(input: { numbers: number[]; slot: string; token?: string; revoked?: boolean }): Promise<string[]> {
  const { createHash } = await import("crypto");
  return withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: { in: input.numbers } } });
    await tx.driverRoute.deleteMany({ where: { storeId, slot: input.slot } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const frozen = await tx.listing.findFirst({ where: { storeId, frozen: true, variants: { some: {} } }, include: { variants: { take: 1 } } });
    const plain = await tx.listing.findFirstOrThrow({ where: { storeId, variants: { some: {} } }, include: { variants: { take: 1 } } });
    const route = input.token
      ? await tx.driverRoute.create({
          data: {
            storeId, slot: input.slot, driverName: "Kofi", driverPhone: "+17135552468",
            tokenHash: createHash("sha256").update(input.token).digest("hex"),
            expiresAt: new Date(Date.now() + 6 * 60 * 60_000), sentAt: new Date(), revokedAt: input.revoked ? new Date() : null,
          },
        })
      : null;
    const ids: string[] = [];
    for (const [i, number] of input.numbers.entries()) {
      const variant = (i === 0 && frozen ? frozen : plain).variants[0];
      const order = await tx.order.create({
        data: {
          storeId, number, customerId: customer.id, status: "READY", fulfillment: "store-delivery", pickupSlot: input.slot,
          subtotalCents: 2000, bufferCents: 200, deliveryFeeCents: 499, totalAuthorizedCents: 2699, totalCents: 2499, capturedAmountCents: 2499,
          deliveryLine1: `${100 + i * 400} Main St`, deliveryCity: "Houston", deliveryState: "TX", deliveryZip: "77002",
          // Nearest to the store first: each stop sits further north.
          deliveryLat: 29.70 + i * 0.05, deliveryLng: -95.40,
          notes: i === 1 ? "Gate code 4411" : null,
          driverRouteId: route?.id ?? null,
          paymentIntentId: `pi_e2e_route_${number}_${Date.now()}`,
          lines: { create: { listingVariantId: variant.id, qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 2000, status: "picked" } },
        },
      });
      ids.push(order.id);
    }
    return ids;
  });
}

export async function deleteDriverRouteOrders(numbers: number[], slot: string): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: { in: numbers } } });
    await tx.driverRoute.deleteMany({ where: { storeId, slot } });
  });
}

/**
 * Accepted orders for batch picking (#564), oldest first, sharing the store's first listing.
 * Order i gets the shared item ×(i === 0 ? 2 : 1) plus one item of its own. Remove with deleteBatchOrders.
 */
export async function insertBatchOrders(numbers: number[], fulfillments: string[]): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: { in: numbers } } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listings = await tx.listing.findMany({
      where: { storeId, active: true, variants: { some: {} } },
      include: { variants: { take: 1 } },
      orderBy: { id: "asc" },
      take: numbers.length + 1,
    });
    if (listings.length < numbers.length + 1) throw new Error("mama-ngozi needs more listings");
    const [shared, ...own] = listings;
    for (const [i, number] of numbers.entries()) {
      const sharedQty = i === 0 ? 2 : 1;
      const lines = [
        { listingVariantId: shared.variants[0].id, qtyOrdered: sharedQty, unitPriceCents: shared.variants[0].price },
        { listingVariantId: own[i].variants[0].id, qtyOrdered: 1, unitPriceCents: own[i].variants[0].price },
      ];
      const subtotal = lines.reduce((sum, line) => sum + line.qtyOrdered * line.unitPriceCents, 0);
      await tx.order.create({
        data: {
          storeId, number, customerId: customer.id, status: "ACCEPTED", fulfillment: fulfillments[i] ?? "pickup",
          subtotalCents: subtotal, bufferCents: subtotal, totalAuthorizedCents: subtotal * 2, totalCents: subtotal,
          paymentIntentId: `pi_seed_e2e_${number}_${Date.now()}`, acceptedAt: new Date(),
          createdAt: new Date(Date.now() - (numbers.length - i) * 60_000),
          lines: { create: lines },
        },
      });
    }
  });
}

export async function deleteBatchOrders(numbers: number[]): Promise<void> {
  await withMama(async (tx, storeId) => {
    const orders = await tx.order.findMany({ where: { storeId, number: { in: numbers } }, select: { id: true, pickBatchId: true } });
    const batchIds = [...new Set(orders.flatMap((order) => (order.pickBatchId ? [order.pickBatchId] : [])))];
    const ids = orders.map((order) => order.id);
    await tx.substitutionRequest.deleteMany({ where: { orderId: { in: ids } } });
    await tx.notificationLog.deleteMany({ where: { orderId: { in: ids } } });
    await tx.order.deleteMany({ where: { id: { in: ids } } });
    await tx.pickBatch.deleteMany({ where: { id: { in: batchIds } } });
  });
}

/**
 * A completed order opened by `token` (#724): two picked lines, inside the problem-report window.
 * With `substitutions`, each line also has a pending swap prompt. Remove with deleteBatchOrders.
 */
export async function insertRecoveryOrder(input: { number: number; token: string; substitutions?: boolean }): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: input.number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listings = await tx.listing.findMany({
      where: { storeId, active: true, variants: { some: {} } },
      include: { variants: { take: 1 } },
      orderBy: { id: "asc" },
      take: 3,
    });
    if (listings.length < 3) throw new Error("mama-ngozi needs more listings");
    const [first, second, swap] = listings.map((listing) => listing.variants[0]);
    const order = await tx.order.create({
      data: {
        storeId, number: input.number, customerId: customer.id, status: input.substitutions ? "SUBSTITUTION_PENDING" : "COMPLETED", fulfillment: "pickup",
        subtotalCents: 2500, bufferCents: 250, totalAuthorizedCents: 2750, totalCents: 2500, capturedAmountCents: 2500,
        paymentIntentId: `pi_e2e_recovery_${input.number}_${Date.now()}`, trackingToken: input.token, completedAt: new Date(),
        lines: {
          create: [
            { listingVariantId: first.id, qtyOrdered: 2, qtyPicked: 2, unitPriceCents: 1000, status: "picked", swapRule: "store_suggests" },
            { listingVariantId: second.id, qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 500, status: "picked", swapRule: "store_suggests" },
          ],
        },
      },
      include: { lines: true },
    });
    if (!input.substitutions) return;
    for (const line of order.lines) {
      await tx.substitutionRequest.create({
        data: {
          storeId, orderId: order.id, orderLineId: line.id, proposedVariantId: swap.id,
          proposedUnitPriceCents: line.unitPriceCents, qty: 1, expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
    }
  });
}

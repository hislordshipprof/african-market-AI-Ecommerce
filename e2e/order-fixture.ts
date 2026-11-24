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
  /** A store-delivery order to this address, with its fee in the total (#742). */
  delivery?: { line1: string | null; city: string | null; state: string | null; zip: string | null; feeCents: number };
  /** A booked slot start, a UTC ISO instant (#751). */
  pickupSlot?: string;
  /** The platform service fee and the fee stored at capture (service fee + the store's card fee). */
  fees?: { serviceFeeCents: number; platformFeeCents: number };
  /** A succeeded refund that returns the platform fee in proportion (#757). */
  refundCents?: number;
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
    // The total already holds the service fee, so the goods are what is left of it.
    const goods = amount - (input.fees?.serviceFeeCents ?? 0);
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
        fulfillment: input.delivery ? "store-delivery" : "pickup",
        subtotalCents: goods,
        bufferCents: 100,
        pickupSlot: input.pickupSlot ?? null,
        totalAuthorizedCents: amount + (input.delivery?.feeCents ?? 0) + 100,
        totalCents: amount + (input.delivery?.feeCents ?? 0),
        serviceFeeCents: input.fees?.serviceFeeCents ?? 0,
        platformFeeCents: input.fees?.platformFeeCents ?? null,
        deliveryFeeCents: input.delivery?.feeCents ?? 0,
        deliveryLine1: input.delivery?.line1 ?? null,
        deliveryCity: input.delivery?.city ?? null,
        deliveryState: input.delivery?.state ?? null,
        deliveryZip: input.delivery?.zip ?? null,
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
            unitPriceCents: goods,
          },
        },
      },
    });
    if (input.refundCents) {
      await tx.refundRequest.create({
        data: {
          storeId, orderId: order.id, paymentIntentId: order.paymentIntentId!, key: `e2e-inbox-refund-${input.number}-${Date.now()}`,
          amountCents: input.refundCents, refundApplicationFee: true, state: "CREATED", providerStatus: "succeeded",
        },
      });
    }
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

export async function setOrderReadyEstimate(number: number, readyEstimateAt: Date): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.updateMany({ where: { storeId, number }, data: { readyEstimateAt } });
  });
}

/** Pins when an order was placed and when its substitution requests expire, so a test can expect a fixed clock time (#737). */
export async function setOrderTimes(number: number, times: { createdAt: Date; substitutionExpiresAt?: Date }): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.updateMany({ where: { storeId, number }, data: { createdAt: times.createdAt } });
    if (times.substitutionExpiresAt) {
      await tx.substitutionRequest.updateMany({ where: { storeId, order: { number } }, data: { expiresAt: times.substitutionExpiresAt } });
    }
  });
}

/** Gives a courier order a tracking token and the courier a drop-off ETA (#737). */
export async function setCourierDropoff(number: number, token: string, dropoffEta: Date): Promise<void> {
  await withMama(async (tx, storeId) => {
    const order = await tx.order.findFirstOrThrow({ where: { storeId, number }, include: { deliveries: true } });
    await tx.order.update({ where: { id: order.id }, data: { trackingToken: token } });
    for (const delivery of order.deliveries) {
      const courier = (delivery.courierJson ?? {}) as Record<string, unknown>;
      await tx.delivery.update({ where: { id: delivery.id }, data: { courierJson: { ...courier, dropoffEta: dropoffEta.toISOString() } } });
    }
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
export async function insertBatchOrders(numbers: number[], fulfillments: string[], sharedProduct?: string): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: { in: numbers } } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    // sharedProduct puts that master product's listing first, as the item every order shares.
    const named = sharedProduct ? { masterProduct: { name: sharedProduct } } : {};
    const first = await tx.listing.findFirstOrThrow({
      where: { storeId, active: true, variants: { some: {} }, ...named },
      include: { variants: { take: 1 } },
      orderBy: { id: "asc" },
    });
    const rest = await tx.listing.findMany({
      where: { storeId, active: true, variants: { some: {} }, id: { not: first.id } },
      include: { variants: { take: 1 } },
      orderBy: { id: "asc" },
      take: numbers.length,
    });
    const listings = [first, ...rest];
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
export async function insertRecoveryOrder(input: { number: number; token: string; substitutions?: boolean }): Promise<{ names: string[] }> {
  return withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: input.number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listings = await tx.listing.findMany({
      // Named products only: a CSV import from another spec can leave a nameless custom listing first by id.
      where: { storeId, active: true, variants: { some: {} }, OR: [{ customName: { not: null } }, { masterProductId: { not: null } }] },
      include: { variants: { take: 1 }, masterProduct: { select: { name: true } } },
      orderBy: { id: "asc" },
      take: 3,
    });
    if (listings.length < 3) throw new Error("mama-ngozi needs more listings");
    // What the customer reads for each line: product name, then pack (#743).
    const names = listings.slice(0, 2).map((listing) => [listing.customName ?? listing.masterProduct?.name, listing.variants[0].label].filter(Boolean).join(" · "));
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
    if (!input.substitutions) return { names };
    for (const line of order.lines) {
      await tx.substitutionRequest.create({
        data: {
          storeId, orderId: order.id, orderLineId: line.id, proposedVariantId: swap.id,
          proposedUnitPriceCents: line.unitPriceCents, qty: 1, expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
    }
    return { names };
  });
}

/** A tracking-page order (#736): its status, slot, courier and settled refund are set directly. */
export async function insertTrackingOrder(input: {
  number: number;
  token: string;
  status: string;
  fulfillment?: "pickup" | "courier" | "store-delivery" | "ship";
  pickupSlot?: string;
  /** #753: the stored delivery address. */
  address?: { deliveryLine1: string; deliveryCity: string; deliveryState: string; deliveryZip: string };
  courier?: { name: string; trackingUrl: string };
  capturedAmountCents?: number | null;
  refundCents?: number;
  /** #741: the stored money and the one line, for a receipt that must add up. */
  money?: { subtotalCents: number; deliveryFeeCents: number; serviceFeeCents: number; totalAuthorizedCents: number; captureCents?: number };
  line?: { qtyOrdered: number; qtyPicked?: number; unitPriceCents: number; status?: string };
}): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: input.number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listing = await tx.listing.findFirstOrThrow({
      where: { storeId, active: true, variants: { some: {} } },
      include: { variants: { take: 1 } },
      orderBy: { id: "asc" },
    });
    const paymentIntentId = `pi_e2e_tracking_${input.number}_${Date.now()}`;
    const order = await tx.order.create({
      data: {
        storeId, number: input.number, customerId: customer.id, status: input.status, fulfillment: input.fulfillment ?? "pickup",
        pickupSlot: input.pickupSlot ?? null, subtotalCents: 1250, bufferCents: 125, totalAuthorizedCents: 1375, totalCents: 1250,
        capturedAmountCents: input.capturedAmountCents ?? null, refundId: input.refundCents ? `re_e2e_${input.number}` : null,
        paymentIntentId, trackingToken: input.token,
        ...input.address,
        ...(input.money && {
          subtotalCents: input.money.subtotalCents, deliveryFeeCents: input.money.deliveryFeeCents, serviceFeeCents: input.money.serviceFeeCents,
          totalAuthorizedCents: input.money.totalAuthorizedCents,
          totalCents: input.money.subtotalCents + input.money.deliveryFeeCents + input.money.serviceFeeCents,
          captureCents: input.money.captureCents ?? null,
        }),
        lines: { create: { listingVariantId: listing.variants[0].id, qtyOrdered: 1, unitPriceCents: 1250, ...input.line } },
      },
    });
    if (input.courier) {
      await tx.delivery.create({
        data: {
          storeId, orderId: order.id, provider: "doordash", externalId: `e2e-tracking-${input.number}-${Date.now()}`, status: "courier_assigned",
          quoteFeeCents: 699, trackingUrl: input.courier.trackingUrl, courierJson: { name: input.courier.name, vehicle: "Blue Honda Civic" },
        },
      });
    }
    if (input.refundCents) {
      await tx.refundRequest.create({
        data: {
          storeId, orderId: order.id, paymentIntentId, key: `e2e-tracking-refund-${input.number}-${Date.now()}`, amountCents: input.refundCents,
          refundApplicationFee: false, state: "CREATED", providerRefundId: `re_e2e_${input.number}`, providerStatus: "succeeded",
        },
      });
    }
  });
}

/**
 * A pickup order after short picks (#762): one line refunded, one found, one swapped for a named replacement.
 * Before capture it also has a short line waiting on a pricier swap and a line not yet picked with a named
 * substitute; captured, it is Ready with the fees rewritten on the goods picked and the subtotal left stale.
 */
export async function insertShortSwapOrder(input: { number: number; token: string; captured?: boolean; expiresAt?: Date }): Promise<{ swapName: string; pendingName: string; substituteName: string }> {
  return withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number: input.number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listings = await tx.listing.findMany({
      where: { storeId, active: true, variants: { some: {} }, OR: [{ customName: { not: null } }, { masterProductId: { not: null } }] },
      include: { variants: { take: 1 }, masterProduct: { select: { name: true } } },
      orderBy: { id: "asc" },
      take: 6,
    });
    if (listings.length < 6) throw new Error("mama-ngozi needs more listings");
    const [refunded, found, swapped, pending, unpicked, replacement] = listings.map((listing) => listing.variants[0]);
    const name = (index: number) => listings[index].customName ?? listings[index].masterProduct!.name;
    const captured = input.captured ?? false;
    const lines = [
      { listingVariantId: refunded.id, qtyOrdered: 1, qtyPicked: 0, unitPriceCents: 399, status: "refunded" },
      { listingVariantId: found.id, qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 1299, status: "picked" },
      { listingVariantId: swapped.id, qtyOrdered: 1, qtyPicked: 0, unitPriceCents: 499, status: "substituted", swapRule: "named_substitute", substituteVariantId: replacement.id, substitutedVariantId: replacement.id, substitutedUnitPriceCents: 599 },
      ...(captured ? [] : [
        { listingVariantId: pending.id, qtyOrdered: 1, qtyPicked: 0, unitPriceCents: 1099, status: "short", swapRule: "store_suggests" },
        { listingVariantId: unpicked.id, qtyOrdered: 1, qtyPicked: 0, unitPriceCents: 349, status: "pending", swapRule: "named_substitute", substituteVariantId: replacement.id },
      ]),
    ];
    // Placed: $36.45 of goods (captured: $21.97) with a 3% fee; captured on $18.98 of goods at the $0.99 minimum fee.
    const subtotalCents = captured ? 2197 : 3645;
    const placedFee = captured ? 99 : 109;
    const order = await tx.order.create({
      data: {
        storeId, number: input.number, customerId: customer.id, status: captured ? "READY" : "SUBSTITUTION_PENDING", fulfillment: "pickup",
        subtotalCents, serviceFeeCents: placedFee, serviceFeeBps: 300, serviceFeeMinCents: 99, serviceFeeMaxCents: 299,
        bufferCents: 400, totalAuthorizedCents: subtotalCents + placedFee + 400, totalCents: subtotalCents + placedFee,
        capturedAmountCents: captured ? 1997 : null, captureCents: captured ? 1997 : null,
        paymentIntentId: `pi_e2e_762_${input.number}_${Date.now()}`, trackingToken: input.token, acceptedAt: new Date(),
        lines: { create: lines },
      },
      include: { lines: true },
    });
    const byStatus = (status: string) => order.lines.find((line) => line.status === status)!;
    const answeredAt = new Date();
    await tx.substitutionRequest.create({ data: { storeId, orderId: order.id, orderLineId: byStatus("refunded").id, qty: 1, status: "declined", expiresAt: answeredAt, answeredAt } });
    await tx.substitutionRequest.create({
      data: { storeId, orderId: order.id, orderLineId: byStatus("substituted").id, qty: 1, status: "approved", proposedVariantId: replacement.id, proposedUnitPriceCents: 599, expiresAt: answeredAt, answeredAt },
    });
    if (!captured) {
      await tx.substitutionRequest.create({
        data: {
          storeId, orderId: order.id, orderLineId: byStatus("short").id, qty: 1, proposedVariantId: replacement.id, proposedUnitPriceCents: 1199,
          expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60_000),
        },
      });
    }
    return { swapName: name(5), pendingName: name(3), substituteName: name(5) };
  });
}

/**
 * A shipped order at Ready whose stored rate the fake Shippo never quoted, so buying its label is refused (#771).
 * Its 4 lb parcel re-quotes at $9.25 (USPS Ground Advantage, $5.45 + 4 × $0.95). Remove with deleteShipRequoteOrder.
 */
export async function insertShipRequoteOrder(number: number, capturedPostageCents: number): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number } });
    const customer = await tx.customer.findFirstOrThrow({ where: { storeId } });
    const listing = await tx.listing.create({ data: { storeId, customName: `E2E garri ${number}`, price: 1200, stockMode: "unlimited", shippable: true } });
    const variant = await tx.listingVariant.create({ data: { listingId: listing.id, label: "4 lb", price: 1200, weightG: 1814 } });
    const total = 1200 + capturedPostageCents;
    await tx.order.create({
      data: {
        storeId, number, customerId: customer.id, status: "READY", fulfillment: "ship",
        subtotalCents: 1200, bufferCents: 0, deliveryFeeCents: capturedPostageCents, totalAuthorizedCents: total, totalCents: total, capturedAmountCents: total,
        paymentIntentId: `pi_e2e_${number}_${Date.now()}`, readyAt: new Date(),
        deliveryLine1: "8505 Fenton St", deliveryCity: "Silver Spring", deliveryState: "MD", deliveryZip: "20910",
        shippingRateId: `rate_e2e_dead_${number}`, shippingRateExpiresAt: new Date(Date.now() + 86_400_000), shippingPostageCents: capturedPostageCents,
        shippingCarrier: "USPS", shippingService: "Ground Advantage", shippingDays: 5,
        lines: { create: { listingVariantId: variant.id, qtyOrdered: 1, qtyPicked: 1, status: "picked", unitPriceCents: 1200 } },
      },
    });
  });
}

export async function shipRequoteOrder(number: number) {
  return withMama((tx, storeId) => tx.order.findFirstOrThrow({ where: { storeId, number } }));
}

export async function deleteShipRequoteOrder(number: number): Promise<void> {
  await withMama(async (tx, storeId) => {
    await tx.order.deleteMany({ where: { storeId, number } });
    await tx.listingVariant.deleteMany({ where: { listing: { storeId, customName: `E2E garri ${number}` } } });
    await tx.listing.deleteMany({ where: { storeId, customName: `E2E garri ${number}` } });
  });
}

/** The id of a seeded mama-ngozi order, for the new-order email link (#785). */
export async function inboxOrderId(number: number): Promise<string> {
  return withMama(async (tx, storeId) => (await tx.order.findFirstOrThrow({ where: { storeId, number }, select: { id: true } })).id);
}

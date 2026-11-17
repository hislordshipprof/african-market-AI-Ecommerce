import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { correctListingAttributes } from "../catalog/listing-attributes";
import { updateLineSwapRule } from "../cart/service";
import { defaultPrepEstimate } from "../order/service";
import { createListing, reactivateListing, updateListing } from "./service";
import { PREPARED_NEEDS_ALLERGENS } from "./prepared";
import { CATERING_NEEDS_PREPARED } from "./catering";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t570-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)("prepared food listings (#570)", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  const actor = { id: `${RUN}-owner`, email: `${RUN}@owner.test` };
  const variant = { label: "Plate", price: 1200, weightG: 400 };

  async function asAdmin<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }

  function jollof(storeId: string, extra: Partial<Parameters<typeof createListing>[0]> = {}) {
    return createListing({
      storeId, customName: `${RUN} jollof`, price: 1200, stockMode: "status", status: "in_stock",
      frozen: false, perishable: false, variants: [variant], actor, ...extra,
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    await asAdmin(async (tx) => {
      await tx.user.create({ data: { id: actor.id, email: actor.email, name: "Owner", emailVerified: true } });
      storeA = (await tx.store.create({ data: { slug: `${RUN}-a`, name: `A ${RUN}`, themePreset: "palm-and-shea" } })).id;
      storeB = (await tx.store.create({ data: { slug: `${RUN}-b`, name: `B ${RUN}`, themePreset: "lagoon-and-coral" } })).id;
    });
  });

  afterAll(async () => {
    await asAdmin(async (tx) => {
      const stores = { storeId: { in: [storeA, storeB] } };
      await tx.auditLog.deleteMany({ where: stores });
      await tx.orderLine.deleteMany({ where: stores });
      await tx.order.deleteMany({ where: stores });
      await tx.customer.deleteMany({ where: stores });
      await tx.cartLine.deleteMany({ where: stores });
      await tx.cart.deleteMany({ where: stores });
      await tx.stockEvent.deleteMany({ where: stores });
      await tx.listing.deleteMany({ where: stores });
      await tx.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
      await tx.user.deleteMany({ where: { id: actor.id } });
    });
    await raw.$disconnect();
  });

  it("AC3: a prepared item stays off sale until its owner states its allergens, and goes off sale again if they are withdrawn", async () => {
    const created = await jollof(storeA, { prepared: "hot", prepMinutes: 20 });
    expect(created).toMatchObject({ prepared: "hot", prepMinutes: 20, active: false });
    await expect(reactivateListing(storeA, created.id, actor)).rejects.toThrow(PREPARED_NEEDS_ALLERGENS);

    // "Unknown" is not a statement of allergens.
    await correctListingAttributes(storeA, actor, created.id, { allergens: { status: "unknown", values: [] } });
    await expect(reactivateListing(storeA, created.id, actor)).rejects.toThrow(PREPARED_NEEDS_ALLERGENS);

    await correctListingAttributes(storeA, actor, created.id, { allergens: { status: "known", values: [] } });
    expect((await reactivateListing(storeA, created.id, actor)).active).toBe(true);

    // Back to the catalog value (none for a custom dish): off sale in the same write.
    expect(await correctListingAttributes(storeA, actor, created.id, { allergens: { status: "catalog", values: [] } }))
      .toEqual({ ok: true, heldForAllergens: true });
    expect((await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: created.id } })).active).toBe(false);
  });

  it("AC3: marking an on-sale grocery listing as prepared takes it off sale until allergens are stated; grocery is unaffected", async () => {
    const grocery = await jollof(storeA);
    expect(grocery.active).toBe(true);
    const updated = await updateListing({ storeId: storeA, listingId: grocery.id, prepared: "cold", prepMinutes: 0, actor });
    expect(updated).toMatchObject({ prepared: "cold", prepMinutes: 0, active: false, heldForAllergens: true });
    await expect(updateListing({ storeId: storeA, listingId: grocery.id, prepared: "hot", prepMinutes: 121, actor }))
      .rejects.toThrow(/Prep time/);
  });

  it("isolation: another store can neither mark this store's listing prepared nor publish it", async () => {
    const listing = await jollof(storeA, { prepared: "hot", prepMinutes: 10 });
    await correctListingAttributes(storeA, actor, listing.id, { allergens: { status: "known", values: ["peanuts"] } });
    await expect(updateListing({ storeId: storeB, listingId: listing.id, prepared: null, actor })).rejects.toThrow();
    await expect(reactivateListing(storeB, listing.id, actor)).rejects.toThrow();
    expect(await correctListingAttributes(storeB, actor, listing.id, { allergens: { status: "unknown", values: [] } }))
      .toEqual({ ok: false, error: "Listing not found" });
    const row = await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(row).toMatchObject({ prepared: "hot", active: false });
  });

  it("AC4, AC5: a prepared cart line refuses a swap, and an order's prep estimate adds its longest prepared item", async () => {
    const hot = await jollof(storeA, { prepared: "hot", prepMinutes: 25 });
    const cold = await jollof(storeA, { prepared: "cold", prepMinutes: 5 });
    const rice = await jollof(storeA);
    const scoped = storeScoped(storeA);
    const cartId = (await scoped.cart.create({ data: { storeId: storeA } })).id;
    const line = await scoped.cartLine.create({ data: { storeId: storeA, cartId, variantId: hot.variants[0].id, qty: 1, swapRule: "exact_only" } });
    await expect(updateLineSwapRule(storeA, cartId, line.id, "store_suggests", null)).rejects.toThrow(/exact item only/);
    await expect(updateLineSwapRule(storeA, cartId, line.id, "named_substitute", rice.variants[0].id)).rejects.toThrow(/exact item only/);
    expect((await scoped.cartLine.findUniqueOrThrow({ where: { id: line.id } })).swapRule).toBe("exact_only");

    const customer = await scoped.customer.create({ data: { storeId: storeA, name: "Ada", email: `${RUN}@shopper.test`, phone: "+15551234567" } });
    const order = await scoped.order.create({
      data: {
        storeId: storeA, number: 1, customerId: customer.id, status: "AUTHORIZED", fulfillment: "pickup",
        subtotalCents: 3600, bufferCents: 0, totalAuthorizedCents: 3600, totalCents: 3600, paymentIntentId: `pi_${RUN}`,
      },
    });
    await scoped.orderLine.createMany({
      data: [hot, cold, rice].map((listing) => ({
        storeId: storeA, orderId: order.id, listingVariantId: listing.variants[0].id, qtyOrdered: 1, unitPriceCents: 1200, swapRule: "exact_only",
      })),
    });
    // Store prep 30 + the hot dish's 25 (the cold one is made alongside it).
    expect(await defaultPrepEstimate(storeA, order.id, 30)).toBe(55);
    expect(await defaultPrepEstimate(storeB, order.id, 30)).toBe(30);
  });

  it("#571 AC1: a prepared listing can be catering with a lead time and minimum; grocery cannot, and going back to grocery clears it", async () => {
    const tray = await jollof(storeA, { prepared: "hot", prepMinutes: 30, cateringLeadHours: 48, cateringMinQty: 10 });
    expect(tray).toMatchObject({ cateringLeadHours: 48, cateringMinQty: 10 });
    await expect(jollof(storeA, { cateringLeadHours: 24, cateringMinQty: 2 })).rejects.toThrow(CATERING_NEEDS_PREPARED);
    // Five days leaves no slot inside the 5-day hold.
    await expect(updateListing({ storeId: storeA, listingId: tray.id, cateringLeadHours: 120, cateringMinQty: 10, actor }))
      .rejects.toThrow(/lead time/);
    expect(await updateListing({ storeId: storeA, listingId: tray.id, cateringLeadHours: 4, cateringMinQty: 1, actor }))
      .toMatchObject({ cateringLeadHours: 4, cateringMinQty: 1 });
    expect(await updateListing({ storeId: storeA, listingId: tray.id, prepared: null, actor }))
      .toMatchObject({ prepared: null, cateringLeadHours: null, cateringMinQty: null });
    await expect(updateListing({ storeId: storeB, listingId: tray.id, cateringLeadHours: 24, cateringMinQty: 1, actor })).rejects.toThrow();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";

const requirePlatformAdmin = vi.fn();
vi.mock("./session", () => ({ requirePlatformAdmin: () => requirePlatformAdmin() }));

const { viewOrderDetail, ORDER_VIEW_ACTION } = await import("./order-detail");

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t537d-${Date.now()}`;
const TOKEN = `trk_${RUN}_secretvalue9f3a`;

let prisma: PrismaClient;
const storeId = crypto.randomUUID();
const otherStoreId = crypto.randomUUID();
const adminId = `admin-${RUN}`;
const adminEmail = `${adminId}@platform.test`;
const ids: Record<string, string> = {};

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

const viewRows = (orderId: string) =>
  asPlatformAdmin((tx) => tx.auditLog.findMany({ where: { entityType: "order", entityId: orderId, action: ORDER_VIEW_ACTION } }));

beforeAll(async () => {
  if (!hasDb) return;
  prisma = testPrismaClient();
  await prisma.user.create({ data: { id: adminId, email: adminEmail, name: "Admin", role: "platform_admin" } });
  await asPlatformAdmin(async (tx) => {
    for (const [id, slug] of [[storeId, RUN], [otherStoreId, `${RUN}-b`]]) {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${id}, ${`Store ${slug}`}, ${slug}, 'active', 'America/Chicago', now())`;
    }
    const customer = await tx.customer.create({ data: { storeId, name: "Ada Obi", email: `${RUN}@example.com`, phone: "+1 555 0100" } });
    const listing = await tx.listing.create({
      data: { storeId, customName: "Palm oil", price: 899, stockMode: "untracked", variants: { create: [{ label: "1 L", price: 899, weightG: 1000 }, { label: "2 L", price: 1599, weightG: 2000 }] } },
      include: { variants: true },
    });
    const [oneLitre, twoLitre] = listing.variants.sort((a, b) => a.price - b.price);
    const order = await tx.order.create({
      data: {
        storeId,
        number: 7001,
        customerId: customer.id,
        status: "PARTIALLY_REFUNDED",
        fulfillment: "courier",
        subtotalCents: 2697,
        tipCents: 200,
        bufferCents: 270,
        deliveryFeeCents: 799,
        serviceFeeCents: 99,
        totalAuthorizedCents: 4065,
        capturedAmountCents: 3795,
        platformFeeCents: 239,
        paymentIntentId: `pi_${RUN}`,
        trackingToken: TOKEN,
        deliveryLine1: "12 Market St",
        deliveryCity: "Chicago",
        deliveryState: "IL",
        deliveryZip: "60601",
        createdAt: new Date("2026-03-10T15:00:00Z"),
        acceptedAt: new Date("2026-03-10T15:05:00Z"),
        readyAt: new Date("2026-03-10T15:40:00Z"),
        lines: {
          create: [
            { listingVariantId: oneLitre.id, qtyOrdered: 3, qtyPicked: 1, unitPriceCents: 899, status: "short", swapRule: "store_suggests", substitutedVariantId: twoLitre.id, substitutedUnitPriceCents: 1599 },
          ],
        },
      },
    });
    ids.order = order.id;
    await tx.refundRequest.createMany({
      data: [
        { storeId, orderId: order.id, paymentIntentId: `pi_${RUN}`, key: `${RUN}-r1`, amountCents: 300, refundApplicationFee: false, state: "CREATED", providerRefundId: `re_${RUN}_1`, providerStatus: "succeeded", createdAt: new Date("2026-03-10T16:00:00Z") },
        { storeId, orderId: order.id, paymentIntentId: `pi_${RUN}`, key: `${RUN}-r2`, amountCents: 200, refundApplicationFee: false, state: "CREATED", providerRefundId: `re_${RUN}_2`, providerStatus: "failed", createdAt: new Date("2026-03-10T16:05:00Z") },
      ],
    });
    await tx.issueReport.create({ data: { storeId, orderId: order.id, type: "damaged", lines: [], amountCents: 300, state: "auto_refunded" } });
    await tx.delivery.create({ data: { storeId, orderId: order.id, provider: "doordash", externalId: `dd_${RUN}`, status: "delivered", quoteFeeCents: 799, actualFeeCents: 799, trackingUrl: "https://example.com/track", pin: "4821" } });
    const thread = await tx.supportThread.create({ data: { storeId, orderId: order.id, state: "escalated", escalatedAt: new Date("2026-03-10T17:00:00Z"), escalationReason: "sla" } });
    ids.thread = thread.id;
    await tx.supportMessage.create({ data: { storeId, threadId: thread.id, sender: "customer", body: "The bottle leaked." } });
    await tx.auditLog.create({ data: { storeId, actorId: SYSTEM_ACTOR_ID, actorEmail: SYSTEM_ACTOR_EMAIL, action: "capture_retry", entityType: "order", entityId: order.id, createdAt: new Date("2026-03-10T15:41:00Z") } });

    // A second order in the same store: its rows must not leak into the first order's detail.
    const sibling = await tx.order.create({
      data: { storeId, number: 7002, customerId: customer.id, subtotalCents: 500, bufferCents: 0, totalAuthorizedCents: 500, paymentIntentId: `pi_${RUN}_b` },
    });
    ids.sibling = sibling.id;
    await tx.refundRequest.create({ data: { storeId, orderId: sibling.id, paymentIntentId: `pi_${RUN}_b`, key: `${RUN}-r3`, amountCents: 111, refundApplicationFee: false, state: "CREATED", providerStatus: "succeeded" } });
    await tx.auditLog.create({ data: { storeId, actorId: SYSTEM_ACTOR_ID, actorEmail: SYSTEM_ACTOR_EMAIL, action: "auto_cancel", entityType: "order", entityId: sibling.id } });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.auditLog.deleteMany({ where: { storeId: { in: [storeId, otherStoreId] } } });
    await tx.supportMessage.deleteMany({ where: { storeId } });
    await tx.order.deleteMany({ where: { storeId } });
    await tx.listing.deleteMany({ where: { storeId } });
    await tx.customer.deleteMany({ where: { storeId } });
    await tx.store.deleteMany({ where: { id: { in: [storeId, otherStoreId] } } });
  });
  await prisma.user.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  requirePlatformAdmin.mockReset();
  requirePlatformAdmin.mockResolvedValue({ user: { id: adminId, email: adminEmail } });
});

describe.skipIf(!hasDb)("order detail for platform admins (lane DB)", () => {
  it("shows lines as ordered, picked and substituted", async () => {
    const detail = await viewOrderDetail(ids.order);
    expect(detail?.lines).toEqual([
      expect.objectContaining({
        name: "Palm oil",
        variantLabel: "1 L",
        qtyOrdered: 3,
        qtyPicked: 1,
        unitPriceCents: 899,
        swapRule: "store_suggests",
        substitutedName: "Palm oil",
        substitutedVariantLabel: "2 L",
        substitutedUnitPriceCents: 1599,
      }),
    ]);
  });

  it("shows the money: PaymentIntent, authorized, captured, fees and refunds that went through", async () => {
    const detail = await viewOrderDetail(ids.order);
    expect(detail?.payment).toEqual({
      paymentIntentId: `pi_${RUN}`,
      subtotalCents: 2697,
      tipCents: 200,
      deliveryFeeCents: 799,
      serviceFeeCents: 99,
      authorizedCents: 4065,
      capturedCents: 3795,
      // Stored platform fee (service fee + store card fee) plus the courier fee the platform passes on.
      applicationFeeCents: 239 + 799,
      refundedCents: 300,
    });
    expect(detail?.refundRequests.map((r) => [r.amountCents, r.state, r.providerStatus])).toEqual([
      [300, "CREATED", "succeeded"],
      [200, "CREATED", "failed"],
    ]);
  });

  it("shows deliveries, issue reports and the support thread with its messages", async () => {
    const detail = await viewOrderDetail(ids.order);
    expect(detail?.deliveries).toEqual([
      expect.objectContaining({ provider: "doordash", externalId: `dd_${RUN}`, status: "delivered", quoteFeeCents: 799, actualFeeCents: 799 }),
    ]);
    expect(JSON.stringify(detail?.deliveries)).not.toContain("4821");
    expect(detail?.issueReports).toEqual([expect.objectContaining({ type: "damaged", state: "auto_refunded", amountCents: 300 })]);
    expect(detail?.supportThread).toMatchObject({ id: ids.thread, state: "escalated", inPlatformQueue: true });
    expect(detail?.supportThread?.messages.map((m) => m.body)).toEqual(["The bottle leaked."]);
  });

  it("builds the timeline from the order's milestones and its own audit rows, oldest first", async () => {
    await viewOrderDetail(ids.order);
    const detail = await viewOrderDetail(ids.order);
    expect(detail?.timeline.map((entry) => entry.label)).toEqual(["Placed", "Accepted", "Ready", "capture_retry"]);
    expect(detail?.timeline[3]).toMatchObject({ actorEmail: SYSTEM_ACTOR_EMAIL });
  });

  it("never returns the tracking token in full", async () => {
    const detail = await viewOrderDetail(ids.order);
    expect(detail?.trackingTokenHint).toBe("…9f3a");
    expect(JSON.stringify(detail)).not.toContain(TOKEN);
    expect(JSON.stringify(detail)).not.toContain("secretvalue");
  });

  it("writes one platform.order_view audit row per view, naming the admin", async () => {
    const before = (await viewRows(ids.sibling)).length;
    await viewOrderDetail(ids.sibling);
    await viewOrderDetail(ids.sibling);
    const rows = await viewRows(ids.sibling);
    expect(rows.length - before).toBe(2);
    expect(rows.at(-1)).toMatchObject({ storeId, actorId: adminId, actorEmail: adminEmail, entityType: "order", entityId: ids.sibling });
  });

  it("keeps another order's refunds and audit rows out of this order's detail", async () => {
    const detail = await viewOrderDetail(ids.order);
    expect(detail?.refundRequests.map((r) => r.amountCents)).not.toContain(111);
    expect(detail?.timeline.map((entry) => entry.label)).not.toContain("auto_cancel");
    const sibling = await viewOrderDetail(ids.sibling);
    expect(sibling?.refundRequests.map((r) => r.amountCents)).toEqual([111]);
    expect(sibling?.lines).toEqual([]);
  });

  it("returns nothing and audits nothing for an unknown order", async () => {
    const missing = `missing-${RUN}`;
    expect(await viewOrderDetail(missing)).toBeNull();
    expect(await viewRows(missing)).toEqual([]);
  });

  it("reads nothing and audits nothing when the caller is not a platform admin", async () => {
    requirePlatformAdmin.mockRejectedValue(new Error("NEXT_REDIRECT /admin/sign-in"));
    const before = (await viewRows(ids.order)).length;
    await expect(viewOrderDetail(ids.order)).rejects.toThrow("NEXT_REDIRECT");
    expect((await viewRows(ids.order)).length).toBe(before);
  });
});

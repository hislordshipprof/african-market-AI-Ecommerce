import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { setStripeProvider } from "../stripe";
import { capturedPayments, fakeStripeProvider, setAuthorizedAmount } from "../stripe/fake";
import { clearTestSentSms, getTestSentSms } from "../notifications/sms";
import { makeFakeStep } from "../inngest/fake-step";
import { sendCustomerNotification, substitutionTimeout } from "../inngest/functions";
import { getStoreOrders, markLinePicked, markLineShort, markReady } from "./service";
import { applySubstitutionTimeout, resolveSubstitutionByToken } from "./substitution";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t13-${Date.now().toString(36)}`;

type Fn = (ctx: { event: { data: Record<string, string> }; step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const notifyHandler = (sendCustomerNotification as unknown as { fn: Fn }).fn;
const timeoutHandler = (substitutionTimeout as unknown as { fn: Fn }).fn;

/** The AC5 metric: substituted lines without an approved or timed-out prompt. */
async function unapprovedSubstitutions(): Promise<number> {
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM order_lines ol
      WHERE ol.substituted_variant_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM substitution_requests sr
          WHERE sr.order_line_id = ol.id AND sr.status IN ('approved', 'timed_out')
        )`;
    return Number(rows[0].count);
  });
}

describe.skipIf(!hasDb)("substitution prompts (#13, lane DB)", () => {
  let raw: PrismaClient;
  let storeId = "";
  let storeBId = "";
  let slug = "";
  let customerId = "";
  let categoryId = "";
  const masterIds: string[] = [];
  const v: Record<"egusi" | "ogbono" | "crayfish" | "palmOil" | "yam", string> = {
    egusi: "", ogbono: "", crayfish: "", palmOil: "", yam: "",
  };
  let orderSeq = 0;

  async function variant(name: string, price: number, qty: number, master: string | null) {
    const listing = await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price, stockMode: "counted", qty, masterProductId: master },
    });
    const created = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "1 lb", price, weightG: 450 },
    });
    return created.id;
  }

  type LineSpec = { variantId: string; qty: number; price: number; swapRule?: string; substituteVariantId?: string };

  async function order(lines: LineSpec[], holdCents?: number) {
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const hold = holdCents ?? Math.round(subtotal * 1.1);
    const paymentIntentId = `pi_${RUN}_${++orderSeq}`;
    const created = await storeScopedTransaction(storeId, async (tx) => {
      const row = await tx.order.create({
        data: {
          storeId,
          number: orderSeq,
          customerId,
          status: "PICKING",
          subtotalCents: subtotal,
          bufferCents: hold - subtotal,
          totalAuthorizedCents: hold,
          totalCents: subtotal,
          paymentIntentId,
          trackingToken: `tok_${RUN}_${orderSeq}_${"x".repeat(20)}`,
          acceptedAt: new Date(),
        },
      });
      const ids: string[] = [];
      for (const line of lines) {
        const created = await tx.orderLine.create({
          data: {
            storeId,
            orderId: row.id,
            listingVariantId: line.variantId,
            qtyOrdered: line.qty,
            unitPriceCents: line.price,
            swapRule: line.swapRule ?? "exact_only",
            substituteVariantId: line.substituteVariantId ?? null,
          },
        });
        ids.push(created.id);
      }
      return { order: row, lineIds: ids };
    });
    setAuthorizedAmount(paymentIntentId, hold);
    return { id: created.order.id, token: created.order.trackingToken!, paymentIntentId, lineIds: created.lineIds };
  }

  async function requestFor(lineId: string) {
    return storeScoped(storeId).substitutionRequest.findUniqueOrThrow({ where: { orderLineId: lineId } });
  }

  async function expire(orderId: string) {
    await storeScoped(storeId).substitutionRequest.updateMany({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    setStripeProvider(fakeStripeProvider);
    slug = `sub-${RUN}`;
    storeId = (await raw.store.create({ data: { slug, name: "Ada's Market", themePreset: "palm-and-shea" } })).id;
    storeBId = (await raw.store.create({ data: { slug: `sub-b-${RUN}`, name: "Other", themePreset: "palm-and-shea" } })).id;
    await platformAdminTransaction(async (tx) => {
      categoryId = (await tx.category.create({ data: { name: `Soup ${RUN}`, slug: `soup-${RUN}`, sortOrder: 99 } })).id;
      for (const name of ["Egusi", "Ogbono", "Crayfish"]) {
        masterIds.push((await tx.masterProduct.create({ data: { name: `${name} ${RUN}`, categoryId } })).id);
      }
    });
    v.egusi = await variant("Egusi", 1000, 20, masterIds[0]);
    v.ogbono = await variant("Ogbono", 1100, 20, masterIds[1]);
    v.crayfish = await variant("Crayfish", 3000, 20, masterIds[2]);
    v.palmOil = await variant("Palm oil", 1400, 20, null);
    v.yam = await variant("Yam", 1600, 20, null);
    customerId = (await storeScoped(storeId).customer.create({
      data: { storeId, name: "Ada", phone: "+13014482210", email: "ada@example.com" },
    })).id;
  });

  beforeEach(() => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
    clearTestSentSms();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setStripeProvider(null);
    for (const id of [storeId, storeBId]) {
      const scoped = storeScoped(id);
      await scoped.substitutionRequest.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.stockEvent.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
    }
    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { storeId: { in: [storeId, storeBId] } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: masterIds } } });
      await tx.category.deleteMany({ where: { id: categoryId } });
    });
    await raw.store.deleteMany({ where: { id: { in: [storeId, storeBId] } } });
    await raw.$disconnect();
  });

  it("RLS: storeScoped(B) reads none of A's prompts and cannot insert or answer one", async () => {
    const placed = await order([{ variantId: v.egusi, qty: 2, price: 1000 }]);
    expect(await markLineShort(storeId, placed.lineIds[0], 0)).toEqual({ ok: true, orderStatus: "SUBSTITUTION_PENDING" });

    expect(await storeScoped(storeBId).substitutionRequest.findMany()).toEqual([]);
    await expect(
      storeScoped(storeBId).substitutionRequest.create({
        data: { storeId, orderId: placed.id, orderLineId: placed.lineIds[0], qty: 1, expiresAt: new Date() },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect((await storeScoped(storeBId).substitutionRequest.updateMany({ where: { orderId: placed.id }, data: { status: "approved" } })).count).toBe(0);
    // The token is store A's: store B's storefront finds nothing to answer.
    const request = await requestFor(placed.lineIds[0]);
    expect(await resolveSubstitutionByToken(storeBId, placed.token, request.id, "refund")).toEqual({ ok: false, error: "not_found" });
    expect((await requestFor(placed.lineIds[0])).status).toBe("pending");
  });

  it("AC1: marking a line short moves the order to SUBSTITUTION_PENDING, opens a 10-minute prompt and texts the substitutions link", async () => {
    const placed = await order([
      { variantId: v.egusi, qty: 2, price: 1000, swapRule: "store_suggests" },
      { variantId: v.yam, qty: 1, price: 1600 },
    ]);
    const before = Date.now();
    expect(await markLineShort(storeId, placed.lineIds[0], 0)).toEqual({ ok: true, orderStatus: "SUBSTITUTION_PENDING" });

    const stored = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: placed.id } });
    expect(stored.status).toBe("SUBSTITUTION_PENDING");
    const request = await requestFor(placed.lineIds[0]);
    expect(request).toMatchObject({ status: "pending", qty: 2, proposedVariantId: v.ogbono, proposedUnitPriceCents: 1100 });
    expect(request.expiresAt.getTime() - before).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(request.expiresAt.getTime() - before).toBeLessThanOrEqual(10 * 60_000 + 5000);

    // Picking the other lines goes on while the customer answers.
    expect(await markLinePicked(storeId, placed.lineIds[1])).toEqual({ ok: true, orderStatus: "SUBSTITUTION_PENDING" });

    await notifyHandler({ event: { data: { storeId, orderId: placed.id, event: "substitution" } }, step: makeFakeStep() });
    const sms = getTestSentSms().at(-1)!;
    expect(sms.to).toBe("+13014482210");
    expect(sms.text).toContain(`https://${slug}.markets.example/order/${encodeURIComponent(placed.token)}/substitutions`);
  });

  it("AC2: the customer approves a swap from the token link; a wrong token or a second answer changes nothing; the picker's poll shows it", async () => {
    const placed = await order([{ variantId: v.egusi, qty: 1, price: 1000, swapRule: "named_substitute", substituteVariantId: v.palmOil }], 2000);
    await markLineShort(storeId, placed.lineIds[0], 0);
    const request = await requestFor(placed.lineIds[0]);
    expect(request.proposedVariantId).toBe(v.palmOil);

    const other = await order([{ variantId: v.yam, qty: 1, price: 1600 }]);
    expect(await resolveSubstitutionByToken(storeId, other.token, request.id, "swap")).toEqual({ ok: false, error: "not_found" });
    expect(await resolveSubstitutionByToken(storeId, "not-a-token", request.id, "swap")).toEqual({ ok: false, error: "not_found" });
    expect((await requestFor(placed.lineIds[0])).status).toBe("pending");

    expect(await resolveSubstitutionByToken(storeId, placed.token, request.id, "swap")).toEqual({ ok: true, orderStatus: "PICKING" });
    expect(await resolveSubstitutionByToken(storeId, placed.token, request.id, "refund")).toEqual({ ok: false, error: "already_answered" });
    const answered = await requestFor(placed.lineIds[0]);
    expect(answered.status).toBe("approved");
    expect(answered.answeredAt).not.toBeNull();

    const inbox = (await getStoreOrders(storeId)).find((row) => row.id === placed.id)!;
    expect(inbox.status).toBe("PICKING");
    expect(inbox.lines[0]).toMatchObject({ status: "substituted", substitutedVariantId: v.palmOil, substitutionRequest: { status: "approved" } });
  });

  it("never offers a swap that would exceed the card hold: the prompt is refund only, and the timer refunds", async () => {
    // $10 ordered, $11 hold; the named $14 substitute would need $14.
    const placed = await order([{ variantId: v.egusi, qty: 1, price: 1000, swapRule: "named_substitute", substituteVariantId: v.palmOil }], 1100);
    await markLineShort(storeId, placed.lineIds[0], 0);
    const request = await requestFor(placed.lineIds[0]);
    expect(request.proposedVariantId).toBeNull();
    expect(await resolveSubstitutionByToken(storeId, placed.token, request.id, "swap")).toEqual({ ok: false, error: "no_swap_offered" });

    await expire(placed.id);
    expect(await applySubstitutionTimeout(storeId, request.id)).toEqual({ ok: true, orderStatus: "PICKING" });
    const line = await storeScoped(storeId).orderLine.findUniqueOrThrow({ where: { id: placed.lineIds[0] } });
    expect(line).toMatchObject({ status: "refunded", substitutedVariantId: null });
  });

  it("AC3: the timer applies each line's swap rule once, and only when due", async () => {
    const placed = await order([
      { variantId: v.yam, qty: 1, price: 1600, swapRule: "exact_only" },
      { variantId: v.egusi, qty: 2, price: 1000, swapRule: "store_suggests" },
      { variantId: v.egusi, qty: 1, price: 1000, swapRule: "named_substitute", substituteVariantId: v.palmOil },
    ], 10_000);
    for (const lineId of placed.lineIds) await markLineShort(storeId, lineId, 0);
    const requests = await Promise.all(placed.lineIds.map(requestFor));

    expect(await applySubstitutionTimeout(storeId, requests[0].id)).toEqual({ ok: false, error: "not_due" });
    await expire(placed.id);
    for (const request of requests) {
      const step = makeFakeStep();
      await timeoutHandler({ event: { data: { storeId, requestId: request.id, expiresAt: request.expiresAt.toISOString() } }, step });
      expect(step.runs).toEqual(["substitution-apply-rule"]);
    }

    const lines = await Promise.all(placed.lineIds.map((id) => storeScoped(storeId).orderLine.findUniqueOrThrow({ where: { id } })));
    expect(lines.map((line) => [line.status, line.substitutedVariantId])).toEqual([
      ["refunded", null],
      ["substituted", v.ogbono],
      ["substituted", v.palmOil],
    ]);
    expect((await Promise.all(placed.lineIds.map(requestFor))).map((request) => request.status)).toEqual(["timed_out", "timed_out", "timed_out"]);
    expect((await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: placed.id } })).status).toBe("PICKING");
    // A second firing is a no-op.
    expect(await applySubstitutionTimeout(storeId, requests[1].id)).toEqual({ ok: false, error: "already_answered" });
  });

  it("AC4: a $50 order with a $55 hold, an $8 line refunded and a line swapped up $4, captures $46", async () => {
    const placed = await order([
      { variantId: v.crayfish, qty: 1, price: 800 },
      { variantId: v.egusi, qty: 1, price: 1000, swapRule: "named_substitute", substituteVariantId: v.palmOil },
      { variantId: v.yam, qty: 2, price: 1600 },
    ], 5500);
    await markLineShort(storeId, placed.lineIds[0], 0);
    await markLineShort(storeId, placed.lineIds[1], 0);
    const [refund, swap] = await Promise.all([requestFor(placed.lineIds[0]), requestFor(placed.lineIds[1])]);
    expect(swap.proposedUnitPriceCents).toBe(1400);
    await resolveSubstitutionByToken(storeId, placed.token, refund.id, "refund");
    expect(await markReady(storeId, placed.id)).toMatchObject({ ok: false });
    await resolveSubstitutionByToken(storeId, placed.token, swap.id, "swap");
    await markLinePicked(storeId, placed.lineIds[2]);

    expect(await markReady(storeId, placed.id)).toEqual({ ok: true, capturedAmountCents: 4600 });
    expect(capturedPayments.get(placed.paymentIntentId)).toBe(4600);
    // The swapped unit sells from the substitute's stock.
    const palmOil = await storeScoped(storeId).listingVariant.findUniqueOrThrow({ where: { id: v.palmOil }, include: { listing: true } });
    expect(palmOil.listing.qty).toBe(19);
  });

  it("AC5: after answers and timeouts, no order has an unapproved substitution", async () => {
    expect(await unapprovedSubstitutions()).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformFeeLedger } from "./fee-ledger-query";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t546-${Date.now()}`;

let prisma: PrismaClient;
const storeIds: string[] = [];

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

beforeAll(() => {
  if (hasDb) prisma = testPrismaClient();
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.refundRequest.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.customer.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.store.deleteMany({ where: { id: { in: storeIds } } });
  });
  await prisma.$disconnect();
});

/*
 * Hand-computed fixture. Card fee 2.9% (+30¢ on the store's part), each part rounded half up.
 * Months 2030-01 and 2030-02 (UTC) hold only this file's rows.
 *
 * A1 courier, ADR-0021 example: goods 6000 + courier 899 + service 180 = captured 7079.
 *    store card fee 174 + 30 = 204; stored platform fee 180 + 204 = 384; application fee 384 + 899 = 1283.
 *    platform card fee round(5.22) + round(26.071) = 5 + 26 = 31; net 180 − 31 = 149.
 * A2 pickup at 2030-01-31 23:59:59.999: goods 2000 + tip 300 + service 99 = 2399.
 *    store card fee round(66.7) + 30 = 97; platform fee 196 = application fee; platform card fee round(2.871) = 3; net 96.
 *    Issue refund 1030 created 2030-01-31, succeeded 2030-02-03: fee back round(196 × 1030 / 2399) = 84 (February).
 * A3 courier, cancelled after capture (capture nulled): goods 3000 + courier 750 + service 99 = 3849.
 *    store card fee 87 + 30 = 117; platform fee 216; application fee 966; platform card fee 3 + round(21.75) = 25; net 74.
 *    Cancel refund 3849 returns the whole fee 966, of which 750 is the courier fee: net −216.
 * A4 courier issue refund: goods 5000 + courier 899 + service 150 = 6049.
 *    store card fee 145 + 30 = 175; platform fee 325; application fee 1224; platform card fee 4 + 26 = 30; net 120.
 *    Issue refund 1030 keeps the application fee; the service fee share 30 is returned: net −30.
 * A5 courier issue refund whose service fee share is not returned yet: no refund row.
 * A8 pickup whose capture was found only at cancel (never Ready): refunds 2000 = captured, dated by cancelled_at.
 *    store card fee round(55.129) + 30 = 85; platform fee 184; platform card fee 3; net 96. Cancel refund returns 184: net −184.
 * B1 pickup: goods 4000 + service 120 = 4120. store card fee 116 + 30 = 146; platform fee 266; platform card fee round(3.48) = 3; net 117.
 * Not in January: A0 captured 2029-12-31 23:59:59.999, A6 captured 2030-02-01 00:00, A7 still CAPTURING.
 */
describe.skipIf(!hasDb)("platform fee ledger (lane DB)", () => {
  const storeA = crypto.randomUUID();
  const storeB = crypto.randomUUID();
  storeIds.push(storeA, storeB);
  const nameA = `Ledger Market A ${RUN}`;
  const nameB = `Ledger Market B ${RUN}`;
  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, ${nameA}, ${`${RUN}-a`}, 'active', now()), (${storeB}, ${nameB}, ${`${RUN}-b`}, 'active', now())`;
      const customerA = await tx.customer.create({ data: { storeId: storeA, name: "Ledger Customer A" } });
      const customerB = await tx.customer.create({ data: { storeId: storeB, name: "Ledger Customer B" } });
      const order = (storeId: string, customerId: string, number: number, data: Partial<Prisma.OrderUncheckedCreateInput>) =>
        tx.order.create({
          data: {
            storeId,
            customerId,
            number,
            subtotalCents: 1000,
            bufferCents: 0,
            totalAuthorizedCents: 100_000,
            status: "COMPLETED",
            ...data,
          },
        });
      const refund = (storeId: string, orderId: string, key: string, data: Partial<Prisma.RefundRequestUncheckedCreateInput>) =>
        tx.refundRequest.create({
          data: {
            storeId,
            orderId,
            paymentIntentId: `pi_${key}`,
            key: `${RUN}-${key}`,
            amountCents: 0,
            refundApplicationFee: false,
            state: "CREATED",
            providerStatus: "succeeded",
            ...data,
          },
        });

      await order(storeA, customerA.id, 1, {
        fulfillment: "courier", capturedAmountCents: 7079, serviceFeeCents: 180, deliveryFeeCents: 899, platformFeeCents: 384,
        status: "DELIVERED", readyAt: at("2030-01-15T12:00:00Z"), createdAt: at("2030-01-15T10:00:00Z"),
      });
      const a2 = await order(storeA, customerA.id, 2, {
        fulfillment: "pickup", capturedAmountCents: 2399, serviceFeeCents: 99, tipCents: 300, platformFeeCents: 196,
        status: "PARTIALLY_REFUNDED", readyAt: at("2030-01-31T23:59:59.999Z"), createdAt: at("2030-01-31T20:00:00Z"),
      });
      await refund(storeA, a2.id, "a2", {
        amountCents: 1030, refundApplicationFee: true, createdAt: at("2030-01-31T23:59:59.999Z"), succeededAt: at("2030-02-03T09:00:00Z"),
      });
      const a3 = await order(storeA, customerA.id, 3, {
        fulfillment: "courier", capturedAmountCents: null, serviceFeeCents: 99, deliveryFeeCents: 750, platformFeeCents: 216,
        status: "CANCELLED", readyAt: at("2030-01-20T14:00:00Z"), cancelledAt: at("2030-01-20T15:00:00Z"), createdAt: at("2030-01-20T13:00:00Z"),
      });
      await refund(storeA, a3.id, "a3", {
        amountCents: 3849, refundApplicationFee: true, createdAt: at("2030-01-20T14:55:00Z"), succeededAt: at("2030-01-20T14:56:00Z"),
      });
      const a4 = await order(storeA, customerA.id, 4, {
        fulfillment: "courier", capturedAmountCents: 6049, serviceFeeCents: 150, deliveryFeeCents: 899, platformFeeCents: 325,
        status: "PARTIALLY_REFUNDED", readyAt: at("2030-01-22T12:00:00Z"), createdAt: at("2030-01-22T10:00:00Z"),
      });
      await refund(storeA, a4.id, "a4", {
        amountCents: 1030, serviceFeeShareCents: 30, feeRefundId: "fr_a4", createdAt: at("2030-01-25T12:00:00Z"), succeededAt: at("2030-01-25T12:00:01Z"),
      });
      const a5 = await order(storeA, customerA.id, 5, {
        fulfillment: "courier", capturedAmountCents: 6049, serviceFeeCents: 150, deliveryFeeCents: 899, platformFeeCents: 325,
        status: "PARTIALLY_REFUNDED", readyAt: at("2030-01-23T12:00:00Z"), createdAt: at("2030-01-23T10:00:00Z"),
      });
      await refund(storeA, a5.id, "a5", {
        amountCents: 1030, serviceFeeShareCents: 30, feeRefundId: null, createdAt: at("2030-01-26T12:00:00Z"), succeededAt: at("2030-01-26T12:00:01Z"),
      });
      const a8 = await order(storeA, customerA.id, 8, {
        fulfillment: "pickup", capturedAmountCents: null, serviceFeeCents: 99, platformFeeCents: 184,
        status: "CANCELLED", readyAt: null, cancelledAt: at("2030-01-28T10:00:00Z"), createdAt: at("2030-01-28T08:00:00Z"),
      });
      await refund(storeA, a8.id, "a8", {
        amountCents: 2000, refundApplicationFee: true, createdAt: at("2030-01-28T09:58:00Z"), succeededAt: at("2030-01-28T09:59:00Z"),
      });
      await order(storeA, customerA.id, 10, {
        fulfillment: "pickup", capturedAmountCents: 2000, serviceFeeCents: 99, platformFeeCents: 186,
        readyAt: at("2029-12-31T23:59:59.999Z"), createdAt: at("2029-12-31T20:00:00Z"),
      });
      await order(storeA, customerA.id, 11, {
        fulfillment: "pickup", capturedAmountCents: 2000, serviceFeeCents: 99, platformFeeCents: 186,
        readyAt: at("2030-02-01T00:00:00Z"), createdAt: at("2030-01-31T22:00:00Z"),
      });
      await order(storeA, customerA.id, 12, {
        fulfillment: "pickup", capturedAmountCents: 2000, serviceFeeCents: 99, platformFeeCents: 186,
        status: "CAPTURING", readyAt: null, createdAt: at("2030-01-10T10:00:00Z"),
      });
      await order(storeB, customerB.id, 1, {
        fulfillment: "pickup", capturedAmountCents: 4120, serviceFeeCents: 120, platformFeeCents: 266,
        readyAt: at("2030-01-10T12:00:00Z"), createdAt: at("2030-01-10T11:00:00Z"),
      });
    });
  });

  it("shows each captured order with the ADR-0021 example at $1.49 net, to the cent", async () => {
    const ledger = await platformFeeLedger("2030-01");
    const a1 = ledger.rows.find((row) => row.storeId === storeA && row.orderNumber === 1 && row.kind === "capture");
    expect(a1).toMatchObject({
      storeName: nameA,
      capturedCents: 7079,
      serviceFeeCents: 180,
      courierFeeCents: 899,
      platformCardFeeCents: 31,
      applicationFeeCents: 1283,
      feeRefundedCents: 0,
      platformNetCents: 149,
    });
    const b1 = ledger.rows.find((row) => row.storeId === storeB && row.orderNumber === 1);
    expect(b1).toMatchObject({
      storeName: nameB, capturedCents: 4120, serviceFeeCents: 120, courierFeeCents: 0,
      platformCardFeeCents: 3, applicationFeeCents: 266, feeRefundedCents: 0, platformNetCents: 117,
    });
  });

  it("uses UTC month boundaries and leaves out captures outside the month or still capturing", async () => {
    const ledger = await platformFeeLedger("2030-01");
    expect(ledger.month).toMatchObject({ key: "2030-01", startsAt: at("2030-01-01T00:00:00Z"), endsAt: at("2030-02-01T00:00:00Z") });
    const captures = ledger.rows.filter((row) => row.storeId === storeA && row.kind === "capture").map((row) => row.orderNumber);
    expect(captures.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 8]);
  });

  it("shows a refund that returns the fee as a negative row in the month it succeeded", async () => {
    const january = await platformFeeLedger("2030-01");
    const refundsA = (ledger: typeof january) => ledger.rows.filter((row) => row.storeId === storeA && row.kind === "refund");
    expect(refundsA(january).map((row) => [row.orderNumber, row.capturedCents, row.courierFeeCents, row.feeRefundedCents, row.platformNetCents])).toEqual([
      [3, -3849, -750, -966, -216],
      [4, -1030, 0, -30, -30],
      [8, -2000, 0, -184, -184],
    ]);
    const february = await platformFeeLedger("2030-02");
    expect(refundsA(february).map((row) => [row.orderNumber, row.capturedCents, row.feeRefundedCents, row.platformNetCents])).toEqual([
      [2, -1030, -84, -84],
    ]);
  });

  it("totals each store and the month without mixing stores", async () => {
    const ledger = await platformFeeLedger("2030-01");
    const a = ledger.stores.find((s) => s.storeId === storeA);
    const b = ledger.stores.find((s) => s.storeId === storeB);
    expect(a).toEqual({
      storeId: storeA, storeName: nameA, orders: 6,
      capturedCents: 7079 + 2399 + 3849 - 3849 + 6049 + 6049 - 1030 + 2000 - 2000,
      serviceFeeCents: 180 + 99 + 99 + 150 + 150 + 99,
      courierFeeCents: 899 + 750 - 750 + 899 + 899,
      platformCardFeeCents: 31 + 3 + 25 + 30 + 30 + 3,
      applicationFeeCents: 1283 + 196 + 966 + 1224 + 1224 + 184,
      feeRefundedCents: -966 - 30 - 184,
      platformNetCents: 149 + 96 + 74 - 216 + 120 - 30 + 120 + 96 - 184,
    });
    expect(b).toEqual({
      storeId: storeB, storeName: nameB, orders: 1, capturedCents: 4120, serviceFeeCents: 120, courierFeeCents: 0,
      platformCardFeeCents: 3, applicationFeeCents: 266, feeRefundedCents: 0, platformNetCents: 117,
    });
    expect(ledger.total).toMatchObject({ orders: 7, platformNetCents: 225 + 117, feeRefundedCents: -1180 });
  });

  it("never returns more fee than the order paid across its refunds", async () => {
    // Application fee 185 on 2000: each half refund is round(92.5) = 93 in proportion, so the second is held to 92.
    await asPlatformAdmin(async (tx) => {
      const customer = await tx.customer.create({ data: { storeId: storeA, name: "Cap Customer" } });
      const order = await tx.order.create({
        data: {
          storeId: storeA, customerId: customer.id, number: 30, subtotalCents: 1000, bufferCents: 0, totalAuthorizedCents: 3000,
          fulfillment: "pickup", status: "REFUNDED", capturedAmountCents: 2000, serviceFeeCents: 99, platformFeeCents: 185,
          readyAt: at("2030-03-02T12:00:00Z"),
        },
      });
      for (const [key, created] of [["cap1", "2030-03-05T10:00:00Z"], ["cap2", "2030-03-06T10:00:00Z"]]) {
        await tx.refundRequest.create({
          data: {
            storeId: storeA, orderId: order.id, paymentIntentId: "pi_cap", key: `${RUN}-${key}`, amountCents: 1000,
            refundApplicationFee: true, state: "CREATED", providerStatus: "succeeded", createdAt: at(created), succeededAt: at(created),
          },
        });
      }
    });
    const march = await platformFeeLedger("2030-03");
    expect(march.rows.filter((row) => row.storeId === storeA && row.kind === "refund").map((row) => row.feeRefundedCents)).toEqual([-93, -92]);
  });

  it("stamps a refund's success time once, in UTC, whatever path records it", async () => {
    const before = Date.now();
    const id = await asPlatformAdmin(async (tx) => {
      const customer = await tx.customer.create({ data: { storeId: storeB, name: "Stamp Customer" } });
      const order = await tx.order.create({
        data: { storeId: storeB, customerId: customer.id, number: 40, subtotalCents: 1000, bufferCents: 0, totalAuthorizedCents: 1000 },
      });
      const row = await tx.refundRequest.create({
        data: { storeId: storeB, orderId: order.id, paymentIntentId: "pi_stamp", key: `${RUN}-stamp`, amountCents: 500, refundApplicationFee: true, state: "CREATED", providerStatus: "pending" },
      });
      expect(row.succeededAt).toBeNull();
      return row.id;
    });
    const succeeded = await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`SELECT set_config('TimeZone', 'America/Chicago', true)`;
      return tx.refundRequest.update({ where: { id }, data: { providerStatus: "succeeded" } });
    });
    expect(succeeded.succeededAt!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(succeeded.succeededAt!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    const later = await asPlatformAdmin((tx) => tx.refundRequest.update({ where: { id }, data: { feeRefundId: "fr_later", providerStatus: "succeeded" } }));
    expect(later.succeededAt).toEqual(succeeded.succeededAt);
  });
});

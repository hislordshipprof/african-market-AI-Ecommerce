import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests, TestSender } from "../email/send";
import { makeFakeStep } from "../inngest/fake-step";
import { isRlsRejection } from "../listing/cross-store-write";
import { copilotWeeklyReport, listWeeklyReports, reportWeek, weeklyFigures } from "./weekly-report";

type Handler = (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const weeklyHandler = (copilotWeeklyReport as unknown as { fn: Handler }).fn;

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t550-${Date.now().toString(36)}`;
const TZ = "America/Chicago";
/** Monday 16 Nov 2026, 08:00 in Chicago (CST, UTC-6). The report covers Mon 9 to Sun 15 Nov: ISO week 2026-W46. */
const MONDAY_8AM = new Date("2026-11-16T14:00:00Z");
const at = (iso: string) => new Date(iso);

/**
 * Hand-computed fixture for store W (Chicago, digest hour 8).
 * This week: O1 Tue 10 Nov, Ada, egusi 2×$10.00 picked, captured 2000.
 *            O2 Sun 15 Nov 11:30 pm Chicago (UTC Mon 05:30), Bisi, palm oil 1×$15.00 picked, gari 1 short (refunded), captured 1500.
 *            O4 cancelled Thu 12 Nov, out of stock.
 * Next week: Mon 16 Nov 00:30 Chicago, egusi 9×$10.00, captured 9000: not counted.
 * Prior week: O3 Wed 4 Nov, Ada, palm oil 3×$15.00, captured 4500.
 * Goods 3500 over 2 orders against 4500 over 1. Egusi up 0→2, palm oil down 3→1.
 * Ada has two orders by the week's end, Bisi one: repeat 1 of 2 = 50%.
 * Swaps: one approved, two timed out. Issues: damaged $5.00 auto-refunded, missing $15.00 in review.
 * Yam: counted, 2 on hand, 10 sold in 14 days → 2 days left, out Wednesday.
 */
describe.skipIf(!hasDb)("copilot weekly report (lane database)", () => {
  let raw: PrismaClient;
  const owners = [`weekly-owner1-${RUN}`, `weekly-owner2-${RUN}`];
  const staffW = `weekly-staff-${RUN}`;
  const ownerB = `weekly-ownerb-${RUN}`;
  let storeW = "";
  let storeLate = "";
  let storeSuspended = "";
  let storeB = "";

  async function asStore<T>(storeId: string, fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    const store = (slug: string, name: string, extra: object = {}) =>
      raw.store.create({ data: { slug: `${slug}-${RUN}`, name, timezone: TZ, digestHour: 8, ...extra } }).then((s) => s.id);
    storeW = await store("weekly-w", "Weekly W");
    storeLate = await store("weekly-late", "Weekly Late", { digestHour: 9 });
    storeSuspended = await store("weekly-susp", "Weekly Suspended", { status: "suspended" });
    storeB = await store("weekly-b", "Weekly B", { digestHour: 21 });
    await raw.user.createMany({ data: [...owners, staffW, ownerB].map((id) => ({ id, name: id, email: `${id}@example.com` })) });
    await storeScoped(storeW).storeMembership.createMany({
      data: [...owners.map((userId) => ({ storeId: storeW, userId, role: "owner" })), { storeId: storeW, userId: staffW, role: "staff" }],
    });
    for (const id of [storeLate, storeSuspended, storeB]) {
      await storeScoped(id).storeMembership.create({ data: { storeId: id, userId: ownerB, role: "owner" } });
    }

    await asStore(storeW, async (tx) => {
      const listing = (customName: string, extra: object = {}) =>
        tx.listing.create({ data: { storeId: storeW, customName, price: 1000, stockMode: "always", ...extra } });
      const egusi = await listing("Egusi");
      const palm = await listing("Palm oil");
      const gari = await listing("Gari");
      const yam = await listing("Puna Yam", { stockMode: "counted", qty: 2, confidence: 1 });
      const variant = (listingId: string, price: number) => tx.listingVariant.create({ data: { listingId, label: "Each", price, weightG: 500 } });
      const vEgusi = await variant(egusi.id, 1000);
      const vPalm = await variant(palm.id, 1500);
      const vGari = await variant(gari.id, 400);
      const ada = await tx.customer.create({ data: { storeId: storeW, name: "Ada" } });
      const bisi = await tx.customer.create({ data: { storeId: storeW, name: "Bisi" } });

      let number = 0;
      const order = (customerId: string, createdAt: Date, capturedAmountCents: number, extra: object = {}) =>
        tx.order.create({
          data: {
            storeId: storeW, number: ++number, customerId, status: "COMPLETED", subtotalCents: 0, bufferCents: 0,
            totalAuthorizedCents: 0, capturedAmountCents, platformFeeCents: 0, createdAt, ...extra,
          },
        });
      const line = (orderId: string, listingVariantId: string, qtyOrdered: number, qtyPicked: number, unitPriceCents: number, status: string) =>
        tx.orderLine.create({ data: { storeId: storeW, orderId, listingVariantId, qtyOrdered, qtyPicked, unitPriceCents, status } });

      const o1 = await order(ada.id, at("2026-11-10T18:00:00Z"), 2000);
      await line(o1.id, vEgusi.id, 2, 2, 1000, "picked");
      const o2 = await order(bisi.id, at("2026-11-16T05:30:00Z"), 1500);
      await line(o2.id, vPalm.id, 1, 1, 1500, "picked");
      await line(o2.id, vGari.id, 1, 0, 400, "refunded");
      const next = await order(bisi.id, at("2026-11-16T06:30:00Z"), 9000);
      await line(next.id, vEgusi.id, 9, 9, 1000, "picked");
      const o3 = await order(ada.id, at("2026-11-04T18:00:00Z"), 4500);
      await line(o3.id, vPalm.id, 3, 3, 1500, "picked");
      const o4 = await order(bisi.id, at("2026-11-12T16:00:00Z"), 0, { status: "CANCELLED", cancelledAt: at("2026-11-12T17:00:00Z") });
      await tx.auditLog.create({
        data: { storeId: storeW, actorId: owners[0]!, actorEmail: `${owners[0]}@example.com`, action: "store_cancel", entityType: "order", entityId: o4.id, after: { reason: "out_of_stock" } },
      });

      // Swap prompts on the cancelled order's lines, so they touch no seller or short figure.
      const swap = async (status: string, createdAt: Date) => {
        const asked = await line(o4.id, vGari.id, 1, 0, 400, "pending");
        await tx.substitutionRequest.create({ data: { storeId: storeW, orderId: o4.id, orderLineId: asked.id, qty: 1, status, expiresAt: createdAt, createdAt } });
      };
      await swap("approved", at("2026-11-11T15:00:00Z"));
      await swap("timed_out", at("2026-11-12T15:00:00Z"));
      await swap("timed_out", at("2026-11-13T15:00:00Z"));
      await swap("timed_out", at("2026-11-05T15:00:00Z"));

      const refund = await tx.refundRequest.create({
        data: { storeId: storeW, orderId: o1.id, paymentIntentId: `pi_${RUN}_1`, key: `${RUN}-r1`, amountCents: 500, refundApplicationFee: false, state: "CREATED", providerStatus: "succeeded", createdAt: at("2026-11-11T18:00:00Z") },
      });
      await tx.issueReport.create({
        data: { storeId: storeW, orderId: o1.id, type: "damaged", lines: [], amountCents: 500, state: "auto_refunded", refundRequestId: refund.id, createdAt: at("2026-11-11T17:00:00Z") },
      });
      await tx.issueReport.create({
        data: { storeId: storeW, orderId: o2.id, type: "missing", lines: [], amountCents: 1500, state: "in_review", createdAt: at("2026-11-16T05:45:00Z") },
      });

      await tx.stockEvent.create({ data: { storeId: storeW, listingId: yam.id, type: "sale", delta: -10, actorId: owners[0]!, createdAt: at("2026-11-12T15:00:00Z") } });
    });

    await asStore(storeB, async (tx) => {
      const plantain = await tx.listing.create({ data: { storeId: storeB, customName: "Store B Plantain", price: 300, stockMode: "always" } });
      const v = await tx.listingVariant.create({ data: { listingId: plantain.id, label: "Each", price: 300, weightG: 500 } });
      const customer = await tx.customer.create({ data: { storeId: storeB, name: "B shopper" } });
      const o = await tx.order.create({
        data: { storeId: storeB, number: 1, customerId: customer.id, status: "COMPLETED", subtotalCents: 0, bufferCents: 0, totalAuthorizedCents: 0, capturedAmountCents: 99_900, createdAt: at("2026-11-11T18:00:00Z") },
      });
      await tx.orderLine.create({ data: { storeId: storeB, orderId: o.id, listingVariantId: v.id, qtyOrdered: 333, qtyPicked: 333, unitPriceCents: 300, status: "picked" } });
    });
  });

  beforeEach(() => {
    clearTestSentEmails();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MONDAY_8AM);
  });

  afterEach(() => {
    setEmailSenderForTests(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  const reportRows = (storeId: string) => storeScopedTransaction(storeId, (tx) => tx.copilotWeeklyReport.findMany());
  const sentTo = (userId: string) => getTestSentEmails().filter((email) => email.to === `${userId}@example.com`);

  it("reports the store week Mon 00:00 to Sun 24:00 local, counting 11:30 pm Sunday and not 00:30 Monday", async () => {
    expect(reportWeek(TZ, MONDAY_8AM)).toEqual({
      isoWeek: "2026-W46", from: "2026-11-09", to: "2026-11-15", priorFrom: "2026-11-02", priorTo: "2026-11-08",
    });
    expect(await weeklyFigures(storeW, TZ, MONDAY_8AM)).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
      sales: { goodsCents: 3500, orders: 2, priorGoodsCents: 4500, priorOrders: 1, refundsCents: 500 },
      topSellers: [{ name: "Egusi", units: 2 }, { name: "Palm oil", units: 1 }],
      moversUp: [{ name: "Egusi", units: 2, priorUnits: 0 }],
      moversDown: [{ name: "Palm oil", units: 1, priorUnits: 3 }],
      runningOutSoon: [{ name: "Puna Yam", qty: 2, daysLeft: 2, outDay: "Wednesday" }],
      shorts: [{ name: "Gari", shortLines: 1, swappedLines: 0 }],
      issues: [{ reason: "Damaged", reports: 1, refundedCents: 500 }, { reason: "Missing", reports: 1, refundedCents: 0 }],
      cancellations: [{ reason: "Out of stock", orders: 1 }],
      swaps: { answered: 1, timedOut: 2 },
      repeat: { shoppers: 2, repeatShoppers: 1, repeatRatePct: 50 },
    });
  });

  it("sends nothing outside Monday at the digest hour", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.setSystemTime(at("2026-11-17T14:00:00Z"));
    await weeklyHandler({ step: makeFakeStep() });
    vi.setSystemTime(at("2026-11-16T16:00:00Z"));
    await weeklyHandler({ step: makeFakeStep() });
    expect(getTestSentEmails().filter((email) => email.to === `${ownerB}@example.com`)).toHaveLength(0);
    expect(sentTo(owners[0]!)).toHaveLength(0);
  });

  it("on Monday at the digest hour one email goes to each owner of W with only W's figures, once across two runs", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await weeklyHandler({ step: makeFakeStep() });
    await weeklyHandler({ step: makeFakeStep() });

    for (const owner of owners) expect(sentTo(owner)).toHaveLength(1);
    expect(sentTo(staffW)).toHaveLength(0);
    expect(sentTo(ownerB)).toHaveLength(0);
    const rows = await reportRows(storeW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isoWeek: "2026-W46", weekStart: "2026-11-09" });
    expect(rows[0]!.sentAt).not.toBeNull();
    expect(await reportRows(storeLate)).toHaveLength(0);
    expect(await reportRows(storeSuspended)).toHaveLength(0);

    const email = sentTo(owners[0]!)[0]!;
    expect(email.subject).toBe("Weekly W: your week, Nov 9 to Nov 15");
    expect(email.html).toContain("Goods sales: $35.00 from 2 orders (week before: $45.00 from 1 order)");
    expect(email.html).toContain("Egusi: 2 sold");
    expect(email.html).toContain("Palm oil: 1 sold (week before 3)");
    expect(email.html).toContain("Puna Yam: 2 left, est. out Wednesday");
    expect(email.html).toContain("Gari: short on 1 order");
    expect(email.html).toContain("Damaged: 1 report, $5.00 refunded");
    expect(email.html).toContain("Out of stock: 1 cancelled order");
    expect(email.html).toContain("Swap prompts: 1 answered, 2 timed out");
    expect(email.html).toContain("Repeat customers: 50% (1 of 2)");
    expect(email.html).not.toContain("Store B Plantain");
    expect(email.html).not.toContain("$999.00");
  });

  it("a failed send releases the claim; the next run sends the same body to every owner once", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const storeC = (await raw.store.create({ data: { slug: `weekly-c-${RUN}`, name: "Weekly C", timezone: TZ, digestHour: 8 } })).id;
    const ownersC = [`weekly-ownerc1-${RUN}`, `weekly-ownerc2-${RUN}`];
    await raw.user.createMany({ data: ownersC.map((id) => ({ id, name: id, email: `${id}@example.com` })) });
    await storeScoped(storeC).storeMembership.createMany({ data: ownersC.map((userId) => ({ storeId: storeC, userId, role: "owner" })) });
    const real = new TestSender();
    let failing = true;
    setEmailSenderForTests({
      async send(message) {
        if (failing && message.to === `${ownersC[1]}@example.com`) throw new Error("Resend API error 503");
        return real.send(message);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(weeklyHandler({ step: makeFakeStep() })).rejects.toThrow(/still failing for 1 store/);
    const [held] = await reportRows(storeC);
    expect(held).toMatchObject({ claimedAt: null, sentAt: null });
    expect(sentTo(ownersC[1]!)).toHaveLength(0);

    failing = false;
    await weeklyHandler({ step: makeFakeStep() });
    for (const owner of ownersC) expect(sentTo(owner)).toHaveLength(1);
    expect(sentTo(ownersC[1]!)[0]!.html).toBe(sentTo(ownersC[0]!)[0]!.html);
    expect((await reportRows(storeC))[0]!.sentAt).not.toBeNull();
  });

  it("a claim another run holds is not sent again", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const storeD = (await raw.store.create({ data: { slug: `weekly-d-${RUN}`, name: "Weekly D", timezone: TZ, digestHour: 8 } })).id;
    const ownerD = `weekly-ownerd-${RUN}`;
    await raw.user.create({ data: { id: ownerD, name: ownerD, email: `${ownerD}@example.com` } });
    await storeScoped(storeD).storeMembership.create({ data: { storeId: storeD, userId: ownerD, role: "owner" } });
    await storeScopedTransaction(storeD, (tx) => tx.copilotWeeklyReport.create({
      data: { storeId: storeD, isoWeek: "2026-W46", weekStart: "2026-11-09", figures: {}, claimedAt: new Date(MONDAY_8AM.getTime() - 60_000) },
    }));

    await weeklyHandler({ step: makeFakeStep() });

    expect(sentTo(ownerD)).toHaveLength(0);
  });

  it("copilot_weekly_reports: storeScoped(B) reads none of W's rows, cannot insert one for W, and updates nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await weeklyHandler({ step: makeFakeStep() });

    expect(await reportRows(storeB)).toEqual([]);
    expect(await listWeeklyReports(storeB)).toEqual([]);
    await expect(storeScopedTransaction(storeB, (tx) =>
      tx.copilotWeeklyReport.create({ data: { storeId: storeW, isoWeek: "2026-W47", weekStart: "2026-11-16", figures: {} } }),
    )).rejects.toSatisfy(isRlsRejection);
    expect((await storeScopedTransaction(storeB, (tx) =>
      tx.copilotWeeklyReport.updateMany({ where: { storeId: storeW }, data: { sentAt: null } }))).count).toBe(0);
    expect((await reportRows(storeW))[0]!.sentAt).not.toBeNull();
  });

  it("the copilot page lists the last 8 sent reports, newest first", async () => {
    const storeE = (await raw.store.create({ data: { slug: `weekly-e-${RUN}`, name: "Weekly E", timezone: TZ } })).id;
    const weeks = Array.from({ length: 10 }, (_, i) => {
      const monday = new Date(Date.UTC(2026, 8, 7 + 7 * i));
      return { storeId: storeE, isoWeek: `2026-W${37 + i}`, weekStart: monday.toISOString().slice(0, 10), figures: { from: "x" }, sentAt: i === 9 ? null : monday };
    });
    await storeScopedTransaction(storeE, (tx) => tx.copilotWeeklyReport.createMany({ data: weeks }));

    const listed = await listWeeklyReports(storeE);
    expect(listed.map((r) => r.isoWeek)).toEqual(["2026-W45", "2026-W44", "2026-W43", "2026-W42", "2026-W41", "2026-W40", "2026-W39", "2026-W38"]);
  });

  it("without RESEND_API_KEY it logs one warning, sends nothing and succeeds", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storeF = (await raw.store.create({ data: { slug: `weekly-f-${RUN}`, name: "Weekly F", timezone: TZ, digestHour: 8 } })).id;
    await storeScoped(storeF).storeMembership.create({ data: { storeId: storeF, userId: ownerB, role: "owner" } });

    await expect(weeklyHandler({ step: makeFakeStep() })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(getTestSentEmails()).toHaveLength(0);
    expect(await reportRows(storeF)).toHaveLength(0);
  });
});

describe("reportWeek", () => {
  it("names the ISO week across a year end", () => {
    expect(reportWeek("America/Chicago", new Date("2027-01-04T14:00:00Z")).isoWeek).toBe("2026-W53");
    expect(reportWeek("America/Chicago", new Date("2026-01-05T14:00:00Z")).isoWeek).toBe("2026-W01");
  });
});

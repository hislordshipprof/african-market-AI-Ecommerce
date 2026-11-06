import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as dbModule from "../db";
import { storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { cancelledPayments, captureCalls, fakeStripeProvider, reset as resetFakeStripe, scriptRetrieveStatuses, setAuthorizedAmount, setRefundStatus } from "../stripe/fake";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";
import { inngest } from "./client";

const hasDb = !!process.env.DATABASE_URL;

const WEEKDAY_HOURS = {
  mon: { open: "09:00", close: "20:00" },
  tue: { open: "09:00", close: "20:00" },
  wed: { open: "09:00", close: "20:00" },
  thu: { open: "09:00", close: "20:00" },
  fri: { open: "09:00", close: "20:00" },
  sat: { open: "09:00", close: "20:00" },
  sun: { open: "09:00", close: "20:00" },
};

function makeFakeStep() {
  const sleeps: Array<{ name: string; duration: string }> = [];
  const sleepNames: string[] = [];
  const runs: string[] = [];
  return {
    sleeps,
    sleepNames,
    runs,
    async sleep(name: string, duration: string) {
      sleeps.push({ name, duration });
      sleepNames.push(name);
    },
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      runs.push(name);
      return fn();
    },
  };
}

type HandlerCtx = { event: { data: { orderId: string; storeId: string; authorizedAt?: string } }; step: ReturnType<typeof makeFakeStep> };

describe("sweep configuration", () => {
  it("both sweeps are singletons that skip overlapping runs", async () => {
    const { sweepOrphanedAuthorized, reconcileStuckTransitional } = await import("./functions");
    expect(sweepOrphanedAuthorized.opts.singleton).toEqual({ mode: "skip" });
    expect(reconcileStuckTransitional.opts.singleton).toEqual({ mode: "skip" });
  });
});
type Handler = (ctx: HandlerCtx) => Promise<void>;

function getHandler(inngestFn: unknown): Handler {
  return (inngestFn as { fn: Handler }).fn;
}

describe.skipIf(!hasDb)("Inngest handler orchestration (database)", () => {
  let rawPrisma: PrismaClient;
  let storeId: string;
  let storeBId = "";
  let customerId: string;
  let variantId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();
    setStripeProvider(fakeStripeProvider);

    const store = await rawPrisma.store.upsert({
      where: { slug: "inngest-fn-test" },
      update: {
        stripeAccountId: "acct_test_inngest",
        hours: WEEKDAY_HOURS,
        timezone: "America/New_York",
      },
      create: {
        slug: "inngest-fn-test",
        name: "Inngest Function Test Store",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 25,
        stripeAccountId: "acct_test_inngest",
        hours: WEEKDAY_HOURS,
        timezone: "America/New_York",
      },
    });
    storeId = store.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "inngest-fn-test-b" },
      update: {
        stripeAccountId: "acct_test_inngest_b",
        hours: WEEKDAY_HOURS,
        timezone: "America/New_York",
      },
      create: {
        slug: "inngest-fn-test-b",
        name: "Inngest Function Test Store B",
        themePreset: "lagoon-and-coral",
        prepTimeMinutes: 25,
        stripeAccountId: "acct_test_inngest_b",
        hours: WEEKDAY_HOURS,
        timezone: "America/New_York",
      },
    });
    storeBId = storeB.id;

    const scoped = storeScoped(storeId);
    const listing = await scoped.listing.create({
      data: { storeId, customName: "Inngest Test Product", price: 1000, stockMode: "unlimited", frozen: false, perishable: false },
    });
    const v = await scoped.listingVariant.create({
      data: { listingId: listing.id, label: "500g", price: 1000, weightG: 500 },
    });
    variantId = v.id;

    const cust = await scoped.customer.create({
      data: { storeId, name: "Inngest Test Customer", email: "inngest-test@example.com", phone: "+15559990000" },
    });
    customerId = cust.id;
  });

  afterAll(async () => {
    setStripeProvider(null);
    const owned = [storeId, storeBId].filter((id) => id.length > 0);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: owned } } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: owned } } }),
      rawPrisma.orderLine.deleteMany({ where: { storeId: { in: owned } } }),
      rawPrisma.order.deleteMany({ where: { storeId: { in: owned } } }),
      rawPrisma.customer.deleteMany({ where: { storeId: { in: owned } } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: owned } } } }),
      rawPrisma.listing.deleteMany({ where: { storeId: { in: owned } } }),
    ]);
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["inngest-fn-test", "inngest-fn-test-b"] } } });
    await rawPrisma.$disconnect();
  });

  let orderSeq = 80000;
  async function createTestOrder() {
    const num = ++orderSeq;
    return storeScopedTransaction(storeId, async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 1000,
          bufferCents: 100,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 1100,
          totalCents: 1000,
          paymentIntentId: `pi_inngest_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        },
      });
      await tx.orderLine.create({
        data: { storeId, orderId: order.id, listingVariantId: variantId, qtyOrdered: 1, unitPriceCents: 1000 },
      });
      setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
      return order;
    });
  }

  function withMockedTime(date: Date, fn: () => Promise<void>): Promise<void> {
    const OrigDate = globalThis.Date;
    const origNow = Date.now;
    const MockDate = function (this: Date, ...args: unknown[]) {
      if (args.length === 0) return new OrigDate(date);
      return new (OrigDate as unknown as new (...a: unknown[]) => Date)(...args);
    } as unknown as DateConstructor;
    Object.setPrototypeOf(MockDate, OrigDate);
    Object.defineProperty(MockDate, "prototype", { value: OrigDate.prototype });
    MockDate.now = () => date.getTime();
    globalThis.Date = MockDate;
    return fn().finally(() => {
      globalThis.Date = OrigDate;
      Date.now = origNow;
    });
  }

  beforeEach(() => {
    resetFakeStripe();
  });

  describe("acceptanceAlert", () => {
    it("creates audit log for AUTHORIZED order during open hours", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      const step = makeFakeStep();

      await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
        handler({ event: { data: { orderId: order.id, storeId } }, step }),
      );

      expect(step.sleepNames).toContain("wait-15-min");
      expect(step.runs).toContain("check-and-alert");

      const logs = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: order.id, action: "acceptance_alert" },
      });
      expect(logs.length).toBe(1);
    }, 10_000);

    it("skips the alert on a day the hours mark Closed", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      await rawPrisma.store.update({
        where: { id: storeId },
        data: { hours: { monday: "10:00 AM - 7:00 PM", sunday: "Closed" } },
      });
      try {
        await withMockedTime(new Date("2026-11-08T15:00:00-05:00"), () =>
          handler({ event: { data: { orderId: order.id, storeId } }, step: makeFakeStep() }),
        );
        const logs = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: order.id, action: "acceptance_alert" },
        });
        expect(logs.length).toBe(0);
      } finally {
        await rawPrisma.store.update({
          where: { id: storeId },
          data: {
            hours: {
              mon: { open: "09:00", close: "20:00" },
              tue: { open: "09:00", close: "20:00" },
              wed: { open: "09:00", close: "20:00" },
              thu: { open: "09:00", close: "20:00" },
              fri: { open: "09:00", close: "20:00" },
              sat: { open: "09:00", close: "20:00" },
              sun: { open: "09:00", close: "20:00" },
            },
          },
        });
      }
    });

    it("skips audit log when store is closed", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      const step = makeFakeStep();

      await withMockedTime(new Date("2026-11-03T23:00:00-05:00"), () =>
        handler({ event: { data: { orderId: order.id, storeId } }, step }),
      );

      const logs = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: order.id, action: "acceptance_alert" },
      });
      expect(logs.length).toBe(0);
    });

    it("skips audit log for already-accepted order", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
      });
      const step = makeFakeStep();

      await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
        handler({ event: { data: { orderId: order.id, storeId } }, step }),
      );

      const logs = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: order.id, action: "acceptance_alert" },
      });
      expect(logs.length).toBe(0);
    });

    it("deduplicates: second call does not create a second audit entry", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();

      await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), async () => {
        const step1 = makeFakeStep();
        await handler({ event: { data: { orderId: order.id, storeId } }, step: step1 });
        const step2 = makeFakeStep();
        await handler({ event: { data: { orderId: order.id, storeId } }, step: step2 });
      });

      const logs = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: order.id, action: "acceptance_alert" },
      });
      expect(logs.length).toBe(1);
    });

    it("K5: skips alert when order accepted between initial read and locked write", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      const origTx = storeScopedTransaction;

      let txCallCount = 0;
      const spy = vi.spyOn(dbModule, "storeScopedTransaction").mockImplementation(
        (async (sid: string, fn: Parameters<typeof origTx>[1]) => {
          txCallCount++;
          if (txCallCount === 1) {
            const result = await origTx(sid, fn);
            await origTx(storeId, async (tx) => {
              await tx.order.update({ where: { id: order.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
            });
            return result;
          }
          return origTx(sid, fn);
        }) as typeof origTx,
      );

      try {
        await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
          handler({ event: { data: { orderId: order.id, storeId } }, step: makeFakeStep() }),
        );

        const logs = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: order.id, action: "acceptance_alert" },
        });
        expect(logs.length).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("Codex-3: re-published event with old authorizedAt skips sleep and processes immediately", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      const step = makeFakeStep();

      const mockedNow = new Date("2026-11-03T14:00:00-05:00");
      const twentyMinAgo = new Date(mockedNow.getTime() - 20 * 60 * 1000).toISOString();
      await withMockedTime(mockedNow, () =>
        handler({ event: { data: { orderId: order.id, storeId, authorizedAt: twentyMinAgo } }, step }),
      );

      expect(step.sleepNames).toHaveLength(0);
      expect(step.runs).toContain("check-and-alert");
    });

    it("Codex-3: fresh event sleeps the full 15 minutes", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      const step = makeFakeStep();

      const mockedNow = new Date("2026-11-03T14:00:00-05:00");
      const justNow = mockedNow.toISOString();
      await withMockedTime(mockedNow, () =>
        handler({ event: { data: { orderId: order.id, storeId, authorizedAt: justNow } }, step }),
      );

      expect(step.sleepNames).toContain("wait-15-min");
      const duration = step.sleeps.find(s => s.name === "wait-15-min")?.duration;
      expect(duration).toBeDefined();
      const seconds = parseInt(duration!.replace("s", ""), 10);
      expect(seconds).toBeGreaterThan(800);
      expect(seconds).toBeLessThanOrEqual(900);
    });
  });

  describe("autoCancel", () => {
    it("cancels AUTHORIZED order during open hours", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const order = await createTestOrder();
      const step = makeFakeStep();

      await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
        handler({ event: { data: { orderId: order.id, storeId } }, step }),
      );

      expect(step.sleepNames).toContain("wait-30-min");
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
    });

    it("cancels even when store is closed (spec AC#5: unconditional 30-min cancel)", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const order = await createTestOrder();
      const step = makeFakeStep();

      await withMockedTime(new Date("2026-11-03T23:00:00-05:00"), () =>
        handler({ event: { data: { orderId: order.id, storeId } }, step }),
      );

      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
    });

    it("skips cancel when order is already accepted", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const order = await createTestOrder();
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
      });
      const step = makeFakeStep();

      await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
        handler({ event: { data: { orderId: order.id, storeId } }, step }),
      );

      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("ACCEPTED");
    });

    it("skips cancel when order is in CANCELLING (idempotent retry)", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const order = await createTestOrder();
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
      });
      const step = makeFakeStep();

      await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
        handler({ event: { data: { orderId: order.id, storeId } }, step }),
      );

      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
    });

    it("Codex-3: re-published event with 35-min-old authorizedAt skips sleep and cancels immediately", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const order = await createTestOrder();
      const step = makeFakeStep();

      const mockedNow = new Date("2026-11-03T14:00:00-05:00");
      const thirtyFiveMinAgo = new Date(mockedNow.getTime() - 35 * 60 * 1000).toISOString();
      await withMockedTime(mockedNow, () =>
        handler({ event: { data: { orderId: order.id, storeId, authorizedAt: thirtyFiveMinAgo } }, step }),
      );

      expect(step.sleepNames).toHaveLength(0);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
    });

    it("returns early for invalid event data (A6 guard)", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const step = makeFakeStep();

      await handler({ event: { data: { orderId: "", storeId: "" } }, step });
      expect(step.sleepNames).toHaveLength(0);
    });
  });

  describe("sweepOrphanedAuthorized", () => {
    it("re-sends events for orphaned AUTHORIZED orders (S1)", async () => {
      const { sweepOrphanedAuthorized } = await import("./functions");
      const handler = (sweepOrphanedAuthorized as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;

      const order = await createTestOrder();
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { createdAt: new Date(Date.now() - 120_000) },
        });
      });

      const sendMod = await import("./send");
      const spy = vi.spyOn(sendMod, "sendOrderAuthorized").mockResolvedValue();
      const step = makeFakeStep();

      try {
        await handler({ step });
        expect(step.runs).toContain("find-orphaned");
        expect(spy).toHaveBeenCalledWith(storeId, order.id);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("reconcileStuckTransitional", () => {
    it("M4: bad order does not block healthy order from reconciliation", async () => {
      const { reconcileStuckTransitional } = await import("./functions");
      const handler = (reconcileStuckTransitional as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;

      const badOrder = await createTestOrder();
      const healthyOrder = await createTestOrder();

      // Both stuck in CANCELLING for >5 min
      const sixMinAgo = new Date(Date.now() - 6 * 60_000);
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({
          where: { id: badOrder.id },
          data: { status: "CANCELLING", updatedAt: sixMinAgo },
        });
        await tx.order.update({
          where: { id: healthyOrder.id },
          data: { status: "CANCELLING", updatedAt: sixMinAgo },
        });
      });

      const serviceMod = await import("../order/service");
      const origReconcile = serviceMod.reconcileStuckOrder;
      const spy = vi.spyOn(serviceMod, "reconcileStuckOrder").mockImplementation(
        async (sid: string, oid: string) => {
          if (oid === badOrder.id) throw new Error("Simulated Stripe timeout");
          return origReconcile(sid, oid);
        },
      );

      const step = makeFakeStep();
      try {
        await handler({ step });

        // Healthy order should be reconciled despite bad order throwing
        const updated = await storeScoped(storeId).order.findUnique({ where: { id: healthyOrder.id } });
        expect(updated!.status).toBe("CANCELLED");

        // Bad order stays in CANCELLING
        const bad = await storeScoped(storeId).order.findUnique({ where: { id: badOrder.id } });
        expect(bad!.status).toBe("CANCELLING");

        // reconcile_failed audit entry for bad order
        const logs = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: badOrder.id, action: "reconcile_failed" },
        });
        expect(logs.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    }, 10_000);

    it("P4: {ok:false} result creates reconcile_failed audit entry", async () => {
      const { reconcileStuckTransitional } = await import("./functions");
      const handler = (reconcileStuckTransitional as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;

      const order = await createTestOrder();
      const sixMinAgo = new Date(Date.now() - 6 * 60_000);
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLING", updatedAt: sixMinAgo },
        });
      });

      const serviceMod = await import("../order/service");
      const spy = vi.spyOn(serviceMod, "reconcileStuckOrder").mockResolvedValue(
        { ok: false, error: "Refund pending — order stays in CANCELLING for retry" },
      );

      const step = makeFakeStep();
      try {
        await handler({ step });

        const logs = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: order.id, action: "reconcile_failed" },
        });
        expect(logs.length).toBe(1);
        expect((logs[0].after as { error: string }).error).toContain("pending");
      } finally {
        spy.mockRestore();
      }
    });

    it("P4: unknown_stripe_status action creates reconcile_failed audit entry", async () => {
      const { reconcileStuckTransitional } = await import("./functions");
      const handler = (reconcileStuckTransitional as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;

      const order = await createTestOrder();
      const sixMinAgo = new Date(Date.now() - 6 * 60_000);
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLING", updatedAt: sixMinAgo },
        });
      });

      const serviceMod = await import("../order/service");
      const spy = vi.spyOn(serviceMod, "reconcileStuckOrder").mockResolvedValue(
        { ok: true, action: "unknown_stripe_status" },
      );

      const step = makeFakeStep();
      try {
        await handler({ step });

        const logs = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: order.id, action: "reconcile_failed" },
        });
        expect(logs.length).toBe(1);
        expect((logs[0].after as { error: string }).error).toBe("unknown_stripe_status");
      } finally {
        spy.mockRestore();
      }
    });

    it("P4: reconcile_failed cooldown — no duplicate within 1 hour", async () => {
      const { reconcileStuckTransitional } = await import("./functions");
      const handler = (reconcileStuckTransitional as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;

      const order = await createTestOrder();
      const sixMinAgo = new Date(Date.now() - 6 * 60_000);
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLING", updatedAt: sixMinAgo },
        });
      });

      const serviceMod = await import("../order/service");
      const spy = vi.spyOn(serviceMod, "reconcileStuckOrder").mockResolvedValue(
        { ok: false, error: "Refund pending" },
      );

      const step = makeFakeStep();
      try {
        // First sweep: creates audit entry
        await handler({ step });
        // Re-stub updated_at back so findStuckTransitionalOrders still returns it
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: { updatedAt: sixMinAgo },
          });
        });
        // Second sweep: cooldown should prevent duplicate
        await handler({ step: makeFakeStep() });

        const logs = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: order.id, action: "reconcile_failed" },
        });
        expect(logs.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("Codex-3/C4: failed reconcile bumps updated_at so order rotates to back of sweep queue", async () => {
      const { reconcileStuckTransitional } = await import("./functions");
      const handler = (reconcileStuckTransitional as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;

      const order = await createTestOrder();
      const tenMinAgo = new Date(Date.now() - 10 * 60_000);
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLING", updatedAt: tenMinAgo },
        });
      });

      const serviceMod = await import("../order/service");
      const spy = vi.spyOn(serviceMod, "reconcileStuckOrder").mockRejectedValue(
        new Error("Simulated failure"),
      );

      const step = makeFakeStep();
      try {
        await handler({ step });

        const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(updated!.status).toBe("CANCELLING");
        // updated_at should be bumped to recent (within last 30s), not 10 minutes ago
        expect(updated!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 30_000);
      } finally {
        spy.mockRestore();
      }
    });

    it("a refund-failed order the finder returns is cancelled by the cron", async () => {
      const { reconcileStuckTransitional } = await import("./functions");
      const handler = (reconcileStuckTransitional as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;

      const order = await createTestOrder();
      await fakeStripeProvider.capturePaymentIntent(order.paymentIntentId!, 1000, `cron-cover-cap-${order.id}`);
      const failed = await fakeStripeProvider.refundPayment(order.paymentIntentId!, 1000, `cron-cover-fail-${order.id}`);
      setRefundStatus(failed.refundId, "failed");
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "REFUND_FAILED", capturedAmountCents: 1000, refundId: failed.refundId },
        });
      });
      await fakeStripeProvider.refundPayment(order.paymentIntentId!, 1000, `cron-cover-ok-${order.id}`);

      await handler({ step: makeFakeStep() });

      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
    });
  });

  async function orderSnapshot(ownerId: string, orderId: string) {
    const order = await storeScoped(ownerId).order.findUnique({ where: { id: orderId } });
    const audits = await storeScoped(ownerId).auditLog.findMany({
      where: { entityId: orderId },
      orderBy: { action: "asc" },
    });
    return {
      status: order?.status ?? null,
      capturedAmountCents: order?.capturedAmountCents ?? null,
      inngestEventSentAt: order?.inngestEventSentAt?.toISOString() ?? null,
      updatedAt: order?.updatedAt.toISOString() ?? null,
      audits: audits.map((row) => `${row.entityType}:${row.action}`),
    };
  }

  it("another store's id cannot alert, cancel, reconcile or send for this order", async () => {
    const { acceptanceAlert, autoCancel, recordReconcileResult } = await import("./functions");
    const { sendOrderAuthorized } = await import("./send");
    const alert = getHandler(acceptanceAlert);
    const cancel = getHandler(autoCancel);
    const sendSpy = vi.spyOn(inngest, "send").mockResolvedValue({ ids: ["evt_188_cross_store"] });
    const open = new Date("2026-11-03T14:00:00-05:00");
    try {
      const cases = [
        async () => {
          const order = await createTestOrder();
          return { order, run: () => withMockedTime(open, () => alert({ event: { data: { orderId: order.id, storeId: storeBId } }, step: makeFakeStep() })) };
        },
        async () => {
          const order = await createTestOrder();
          return { order, run: () => withMockedTime(open, () => cancel({ event: { data: { orderId: order.id, storeId: storeBId } }, step: makeFakeStep() })) };
        },
        async () => {
          const order = await createTestOrder();
          await storeScopedTransaction(storeId, async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING", acceptedAt: new Date() } });
          });
          return { order, run: () => withMockedTime(open, () => cancel({ event: { data: { orderId: order.id, storeId: storeBId } }, step: makeFakeStep() })) };
        },
        async () => {
          const order = await createTestOrder();
          await storeScopedTransaction(storeId, async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
          });
          scriptRetrieveStatuses(order.paymentIntentId!, ["processing"]);
          return { order, run: () => recordReconcileResult(storeBId, order.id) };
        },
        async () => {
          const order = await createTestOrder();
          return { order, run: () => sendOrderAuthorized(storeBId, order.id) };
        },
      ];
      for (const build of cases) {
        const { order, run } = await build();
        const beforeA = await orderSnapshot(storeId, order.id);
        const beforeB = await orderSnapshot(storeBId, order.id);
        const stripe = { cancelled: cancelledPayments.size, captures: captureCalls.length, sends: sendSpy.mock.calls.length };
        await run();
        expect(await orderSnapshot(storeId, order.id)).toEqual(beforeA);
        expect(await orderSnapshot(storeBId, order.id)).toEqual(beforeB);
        expect(cancelledPayments.size).toBe(stripe.cancelled);
        expect(captureCalls.length).toBe(stripe.captures);
        expect(sendSpy.mock.calls.length).toBe(stripe.sends);
      }

      const alertOrder = await createTestOrder();
      await withMockedTime(open, () => alert({ event: { data: { orderId: alertOrder.id, storeId } }, step: makeFakeStep() }));
      const alertAudits = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: alertOrder.id, action: "acceptance_alert", entityType: "order" },
      });
      expect(alertAudits).toHaveLength(1);

      const authorized = await createTestOrder();
      await withMockedTime(open, () => cancel({ event: { data: { orderId: authorized.id, storeId } }, step: makeFakeStep() }));
      const authorizedRow = await storeScoped(storeId).order.findUnique({ where: { id: authorized.id } });
      expect(authorizedRow!.status).toBe("CANCELLED");
      const autoAudits = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: authorized.id, action: "auto_cancel", entityType: "order" },
      });
      expect(autoAudits).toHaveLength(1);

      const resumed = await createTestOrder();
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: resumed.id }, data: { status: "CANCELLING", acceptedAt: new Date() } });
      });
      setAuthorizedAmount(resumed.paymentIntentId!, resumed.totalAuthorizedCents);
      await withMockedTime(open, () => cancel({ event: { data: { orderId: resumed.id, storeId } }, step: makeFakeStep() }));
      const resumedRow = await storeScoped(storeId).order.findUnique({ where: { id: resumed.id } });
      expect(resumedRow!.status).toBe("CANCELLED");
      expect(resumedRow!.capturedAmountCents).toBeNull();
      const voidAudits = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: resumed.id, action: "void_zero_amount", entityType: "order" },
      });
      const resumedAuto = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: resumed.id, action: "auto_cancel", entityType: "order" },
      });
      expect(voidAudits).toHaveLength(1);
      expect(resumedAuto).toHaveLength(0);

      const stuck = await createTestOrder();
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: stuck.id }, data: { status: "CANCELLING" } });
      });
      setAuthorizedAmount(stuck.paymentIntentId!, stuck.totalAuthorizedCents);
      scriptRetrieveStatuses(stuck.paymentIntentId!, ["processing"]);
      const beforeUpdate = (await storeScoped(storeId).order.findUnique({ where: { id: stuck.id } }))!.updatedAt;
      await recordReconcileResult(storeId, stuck.id);
      const failed = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: stuck.id, action: "reconcile_failed", entityType: "order" },
      });
      expect(failed).toHaveLength(1);
      expect((failed[0].after as { error?: string }).error).toBe("unknown_stripe_status");
      const afterStuck = await storeScoped(storeId).order.findUnique({ where: { id: stuck.id } });
      expect(afterStuck!.updatedAt.getTime()).toBeGreaterThan(beforeUpdate.getTime());

      const owned = await createTestOrder();
      sendSpy.mockClear();
      await sendOrderAuthorized(storeId, owned.id);
      const sent = await storeScoped(storeId).order.findUnique({ where: { id: owned.id } });
      expect(sent!.inngestEventSentAt).not.toBeNull();
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith({
        id: `order-authorized-${owned.id}`,
        name: "order/authorized",
        data: {
          storeId,
          orderId: owned.id,
          authorizedAt: sent!.createdAt.toISOString(),
        },
      });
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("non-order audit rows do not suppress acceptance alerts or reconcile-failed audits", async () => {
    const { acceptanceAlert, recordReconcileResult } = await import("./functions");
    const alertOrder = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "acceptance_alert",
          entityType: "listing",
          entityId: alertOrder.id,
        },
      });
    });
    const handler = getHandler(acceptanceAlert);
    await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
      handler({ event: { data: { orderId: alertOrder.id, storeId } }, step: makeFakeStep() }),
    );
    const alerts = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: alertOrder.id, action: "acceptance_alert", entityType: "order" },
    });
    expect(alerts).toHaveLength(1);
    await withMockedTime(new Date("2026-11-03T14:00:00-05:00"), () =>
      handler({ event: { data: { orderId: alertOrder.id, storeId } }, step: makeFakeStep() }),
    );
    const alertsAgain = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: alertOrder.id, action: "acceptance_alert", entityType: "order" },
    });
    expect(alertsAgain).toHaveLength(1);

    const stuck = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: stuck.id }, data: { status: "CANCELLING" } });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "reconcile_failed",
          entityType: "listing",
          entityId: stuck.id,
          after: { error: "decoy" },
        },
      });
    });
    setAuthorizedAmount(stuck.paymentIntentId!, stuck.totalAuthorizedCents);
    scriptRetrieveStatuses(stuck.paymentIntentId!, ["processing"]);
    await recordReconcileResult(storeId, stuck.id);
    const failed = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: stuck.id, action: "reconcile_failed", entityType: "order" },
    });
    expect(failed).toHaveLength(1);
    await recordReconcileResult(storeId, stuck.id);
    const failedAgain = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: stuck.id, action: "reconcile_failed", entityType: "order" },
    });
    expect(failedAgain).toHaveLength(1);
  });
});

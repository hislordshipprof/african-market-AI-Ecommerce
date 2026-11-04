import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as dbModule from "../db";
import { storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { fakeStripeProvider, reset as resetFakeStripe, setAuthorizedAmount } from "../stripe/fake";

const hasDb = !!process.env.DATABASE_URL;

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
        hours: { mon: { open: "09:00", close: "20:00" }, tue: { open: "09:00", close: "20:00" }, wed: { open: "09:00", close: "20:00" }, thu: { open: "09:00", close: "20:00" }, fri: { open: "09:00", close: "20:00" }, sat: { open: "09:00", close: "20:00" }, sun: { open: "09:00", close: "20:00" } },
        timezone: "America/New_York",
      },
      create: {
        slug: "inngest-fn-test",
        name: "Inngest Function Test Store",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 25,
        stripeAccountId: "acct_test_inngest",
        hours: { mon: { open: "09:00", close: "20:00" }, tue: { open: "09:00", close: "20:00" }, wed: { open: "09:00", close: "20:00" }, thu: { open: "09:00", close: "20:00" }, fri: { open: "09:00", close: "20:00" }, sat: { open: "09:00", close: "20:00" }, sun: { open: "09:00", close: "20:00" } },
        timezone: "America/New_York",
      },
    });
    storeId = store.id;

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
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId } }),
      rawPrisma.orderLine.deleteMany({ where: { storeId } }),
      rawPrisma.order.deleteMany({ where: { storeId } }),
      rawPrisma.customer.deleteMany({ where: { storeId } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId } } }),
      rawPrisma.listing.deleteMany({ where: { storeId } }),
    ]);
    await rawPrisma.store.deleteMany({ where: { slug: "inngest-fn-test" } });
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
  });
});

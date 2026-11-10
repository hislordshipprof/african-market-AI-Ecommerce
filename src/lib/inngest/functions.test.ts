import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { Client } from "pg";
import * as dbModule from "../db";
import { storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { cancelledPayments, captureCalls, fakeStripeProvider, refundRequests, reset as resetFakeStripe, scriptRetrieveStatuses, setAuthorizedAmount, setRefundStatus } from "../stripe/fake";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";
import { inngest } from "./client";

const hasDb = !!process.env.DATABASE_URL;
const realFindStuck = dbModule.findStuckTransitionalOrders;
const realFindOrphaned = dbModule.findOrphanedAuthorizedOrders;
const realFindPending = dbModule.findPendingOrderNotifications;
const realExpireNotifications = dbModule.expireStaleOrderNotifications;
const realFindPickTimeout = dbModule.findPickTimeoutCandidates;
const realFindOrphanHolds = dbModule.findOrphanHoldCarts;

/** Tue 2026-11-03 14:00 America/New_York (UTC-5). */
const OPEN_AT = "2026-11-03T19:00:00.000Z";

const WEEKDAY_HOURS = {
  mon: { open: "09:00", close: "20:00" },
  tue: { open: "09:00", close: "20:00" },
  wed: { open: "09:00", close: "20:00" },
  thu: { open: "09:00", close: "20:00" },
  fri: { open: "09:00", close: "20:00" },
  sat: { open: "09:00", close: "20:00" },
  sun: { open: "09:00", close: "20:00" },
};

let mockedNow: Date | null = null;

/** A real sleep wakes at its target, so the mocked clock moves there (never backwards). */
function wakeMockedClockAt(until: string) {
  if (mockedNow && new Date(until).getTime() > mockedNow.getTime()) mockedNow = new Date(until);
}

function makeFakeStep() {
  const sleepUntils: Array<{ name: string; until: string }> = [];
  const sleepNames: string[] = [];
  const runs: string[] = [];
  const record = (name: string, time: Date | string) => {
    const until = new Date(time).toISOString();
    sleepUntils.push({ name, until });
    sleepNames.push(name);
    return until;
  };
  return {
    sleepUntils,
    sleepNames,
    runs,
    record,
    async sleepUntil(name: string, time: Date | string) {
      wakeMockedClockAt(record(name, time));
    },
    /** Inngest serializes every step result as JSON. */
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      runs.push(name);
      const value = await fn();
      return (value === undefined ? value : JSON.parse(JSON.stringify(value))) as T;
    },
  };
}

/** Holds the first sleep until release(); the clock moves to its target on release. */
function holdSleepUntilReleased(step: ReturnType<typeof makeFakeStep>) {
  let releaseSleep!: () => void;
  let markEntered!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseSleep = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const passThrough = step.sleepUntil.bind(step);
  let held = false;
  step.sleepUntil = async (name: string, time: Date | string) => {
    if (held) return passThrough(name, time);
    held = true;
    const until = step.record(name, time);
    markEntered();
    await released;
    wakeMockedClockAt(until);
  };
  return { entered, release: () => releaseSleep() };
}

function withMockedTime(date: Date, fn: () => Promise<void>): Promise<void> {
  const OrigDate = globalThis.Date;
  const origNow = Date.now;
  mockedNow = new OrigDate(date);
  const MockDate = function (this: Date, ...args: unknown[]) {
    if (args.length === 0) return new OrigDate(mockedNow!);
    return new (OrigDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(MockDate, OrigDate);
  Object.defineProperty(MockDate, "prototype", { value: OrigDate.prototype });
  MockDate.now = () => mockedNow!.getTime();
  globalThis.Date = MockDate;
  return fn().finally(() => {
    globalThis.Date = OrigDate;
    Date.now = origNow;
    mockedNow = null;
  });
}

async function waitForSleepEntry(entered: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timer sleep was not entered")), 10_000);
  });
  try {
    await Promise.race([entered, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type HandlerCtx = { event: { data: { orderId: string; storeId: string; authorizedAt?: string } }; step: ReturnType<typeof makeFakeStep> };

describe("sweep configuration", () => {
  it("both sweeps are singletons that skip overlapping runs", async () => {
    const { sweepOrphanedAuthorized, reconcileStuckTransitional } = await import("./functions");
    expect(sweepOrphanedAuthorized.opts.singleton).toEqual({ mode: "skip" });
    expect(reconcileStuckTransitional.opts.singleton).toEqual({ mode: "skip" });
  });

  it("the notification function is not deduplicated per order, and an idle sweep runs one step", async () => {
    const { sendCustomerNotification, sweepOrphanedAuthorized } = await import("./functions");
    const idempotency = (sendCustomerNotification as { opts?: { idempotency?: unknown } }).opts?.idempotency;
    if (idempotency != null) expect(String(idempotency)).toContain("data.event");
    vi.spyOn(dbModule, "findOrphanedAuthorizedOrders").mockImplementation(async () => realFindOrphaned({ storeIds: [] }));
    vi.spyOn(dbModule, "findPendingOrderNotifications").mockImplementation(async () => realFindPending({ storeIds: [] }));
    vi.spyOn(dbModule, "expireStaleOrderNotifications").mockImplementation(async () => realExpireNotifications({ storeIds: [] }));
    vi.spyOn(dbModule, "findPickTimeoutCandidates").mockImplementation(async (opts) => realFindPickTimeout({ ...opts, storeIds: [] }));
    vi.spyOn(dbModule, "findOrphanHoldCarts").mockImplementation(async (opts) => realFindOrphanHolds({ ...opts, storeIds: [] }));
    try {
      const step = makeFakeStep();
      const handler = (sweepOrphanedAuthorized as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;
      await handler({ step });
      expect(step.runs).toEqual(["find-orphaned"]);
    } finally {
      vi.mocked(dbModule.findOrphanedAuthorizedOrders).mockRestore();
      vi.mocked(dbModule.findPendingOrderNotifications).mockRestore();
      vi.mocked(dbModule.expireStaleOrderNotifications).mockRestore();
      vi.mocked(dbModule.findPickTimeoutCandidates).mockRestore();
      vi.mocked(dbModule.findOrphanHoldCarts).mockRestore();
    }
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
    rawPrisma = testPrismaClient();
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

  async function authorizedAtFromPersistedCreatedAt(orderId: string, createdAtIso: string): Promise<string> {
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { createdAt: new Date(createdAtIso) },
      });
    });
    const row = await storeScoped(storeId).order.findUnique({ where: { id: orderId } });
    expect(row?.createdAt.toISOString()).toBe(createdAtIso);
    return row!.createdAt.toISOString();
  }

  beforeEach(() => {
    resetFakeStripe();
    const ownStores = () => [storeId, storeBId].filter((id) => id.length > 0);
    vi.spyOn(dbModule, "findStuckTransitionalOrders").mockImplementation(async (opts) => {
      if (opts?.storeIds) return realFindStuck(opts);
      return realFindStuck({ storeIds: ownStores() });
    });
    vi.spyOn(dbModule, "findOrphanedAuthorizedOrders").mockImplementation(async (opts) => {
      if (opts?.storeIds) return realFindOrphaned(opts);
      return realFindOrphaned({ storeIds: ownStores() });
    });
    vi.spyOn(dbModule, "findPendingOrderNotifications").mockImplementation(async (opts) => {
      if (opts?.storeIds) return realFindPending(opts);
      return realFindPending({ storeIds: ownStores() });
    });
    vi.spyOn(dbModule, "expireStaleOrderNotifications").mockImplementation(async (opts) => {
      if (opts?.storeIds) return realExpireNotifications(opts);
      return realExpireNotifications({ storeIds: ownStores() });
    });
    vi.spyOn(dbModule, "findPickTimeoutCandidates").mockImplementation(async (opts) => {
      return realFindPickTimeout({ ...opts, storeIds: opts.storeIds ?? ownStores() });
    });
    vi.spyOn(dbModule, "findOrphanHoldCarts").mockImplementation(async (opts) => {
      return realFindOrphanHolds({ ...opts, storeIds: opts?.storeIds ?? ownStores() });
    });
  });

  afterEach(() => {
    vi.mocked(dbModule.findStuckTransitionalOrders).mockRestore();
    vi.mocked(dbModule.findOrphanedAuthorizedOrders).mockRestore();
    vi.mocked(dbModule.findPendingOrderNotifications).mockRestore();
    vi.mocked(dbModule.expireStaleOrderNotifications).mockRestore();
    vi.mocked(dbModule.findPickTimeoutCandidates).mockRestore();
    vi.mocked(dbModule.findOrphanHoldCarts).mockRestore();
  });

  describe("dailyConfidence", () => {
    const ownStoreIds = () => [storeId, storeBId].sort();
    const dayMs = 24 * 60 * 60 * 1000;

    async function runJob(at: Date) {
      const { dailyConfidence } = await import("./functions");
      const spy = vi.spyOn(dbModule, "findStoreIdsAfter").mockImplementation(async (cursor) =>
        ownStoreIds().filter((id) => !cursor || id > cursor),
      );
      try {
        await withMockedTime(at, () =>
          (dailyConfidence as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn({
            step: makeFakeStep(),
          }),
        );
      } finally {
        spy.mockRestore();
      }
    }

    async function idleListing(owner: string, name: string, createdAt: Date, active = true) {
      return storeScoped(owner).listing.create({
        data: { storeId: owner, customName: name, price: 100, stockMode: "counted", qty: 5, active, createdAt, frozen: false, perishable: false },
      });
    }

    it("the daily confidence job keeps decaying an idle listing across runs in each store", async () => {
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * dayMs);
      const a = await idleListing(storeId, "Idle A", eightDaysAgo);
      const b = await idleListing(storeBId, "Idle B", eightDaysAgo);
      const inactive = await idleListing(storeId, "Inactive", eightDaysAgo, false);

      await runJob(now);

      const firstA = await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: a.id } });
      const firstB = await storeScoped(storeBId).listing.findUniqueOrThrow({ where: { id: b.id } });
      expect(firstA.confidence).toBeLessThan(0.6);
      expect(firstA.confidence).toBeGreaterThanOrEqual(0.3);
      expect(firstB.confidence).toBeLessThan(0.6);
      expect(firstA.confidenceUpdatedAt.getTime()).toBe(now.getTime());
      expect(firstB.confidenceUpdatedAt.getTime()).toBe(now.getTime());

      const nextDay = new Date(now.getTime() + dayMs);
      await runJob(nextDay);

      const secondA = await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: a.id } });
      expect(secondA.confidence).toBeLessThan(firstA.confidence);
      expect(secondA.confidenceUpdatedAt.getTime()).toBe(nextDay.getTime());
      const untouched = await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: inactive.id } });
      expect(untouched.confidence).toBe(1);
      expect(untouched.confidenceUpdatedAt.getTime()).toBe(inactive.confidenceUpdatedAt.getTime());
    }, 30_000);

    it("the daily confidence job skips a listing an order holds and finishes", async () => {
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * dayMs);
      const held = await idleListing(storeId, "Held", eightDaysAgo);
      const free = await idleListing(storeId, "Free", eightDaysAgo);
      const holder = new Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SET LOCAL ROLE app_user");
        await holder.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
        await holder.query("SELECT 1 FROM listings WHERE id = $1 FOR UPDATE", [held.id]);

        await runJob(now);

        const heldRow = await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: held.id } });
        const freeRow = await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: free.id } });
        expect(heldRow.confidence).toBe(1);
        expect(freeRow.confidence).toBeLessThan(0.6);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
      }
    }, 30_000);
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

      expect(step.sleepNames).toContain("alert-sleep-0");
      expect(step.runs).toContain("alert-record");

      const logs = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: order.id, action: "acceptance_alert" },
      });
      expect(logs.length).toBe(1);
    }, 10_000);

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

    it("Codex-3: fresh event sleeps the full 15 minutes", async () => {
      const { acceptanceAlert } = await import("./functions");
      const handler = getHandler(acceptanceAlert);
      const order = await createTestOrder();
      const authorizedAt = await authorizedAtFromPersistedCreatedAt(order.id, OPEN_AT);
      const step = makeFakeStep();
      const held = holdSleepUntilReleased(step);
      const paymentIntentId = order.paymentIntentId!;
      const cancelSpy = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent");
      const finished = withMockedTime(new Date(OPEN_AT), () =>
        handler({ event: { data: { orderId: order.id, storeId, authorizedAt } }, step }),
      );
      try {
        await waitForSleepEntry(held.entered);
        expect(step.runs).toEqual(["alert-plan-0"]);
        expect(step.sleepUntils).toEqual([{ name: "alert-sleep-0", until: "2026-11-03T19:15:00.000Z" }]);
        const logsBefore = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: order.id, action: "acceptance_alert", entityType: "order" },
        });
        expect(logsBefore).toHaveLength(0);
        expect(cancelSpy.mock.calls.filter((call) => call[0] === paymentIntentId)).toHaveLength(0);
        expect(captureCalls).toHaveLength(0);
        expect(refundRequests.filter((request) => request.paymentIntentId === paymentIntentId)).toHaveLength(0);
        const before = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(before?.status).toBe("AUTHORIZED");
        held.release();
        await finished;
        expect(step.sleepUntils).toEqual([{ name: "alert-sleep-0", until: "2026-11-03T19:15:00.000Z" }]);
        const logs = await storeScoped(storeId).auditLog.findMany({
          where: { entityId: order.id, action: "acceptance_alert", entityType: "order" },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0]?.storeId).toBe(storeId);
      } finally {
        held.release();
        await finished.catch(() => undefined);
        cancelSpy.mockRestore();
      }
    });

  });

  describe("autoCancel", () => {
    it("cancels AUTHORIZED order during open hours", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const order = await createTestOrder();
      const authorizedAt = await authorizedAtFromPersistedCreatedAt(order.id, OPEN_AT);
      const step = makeFakeStep();
      const held = holdSleepUntilReleased(step);
      const paymentIntentId = order.paymentIntentId!;
      const cancelSpy = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent");
      const finished = withMockedTime(new Date(OPEN_AT), () =>
        handler({ event: { data: { orderId: order.id, storeId, authorizedAt } }, step }),
      );
      try {
        await waitForSleepEntry(held.entered);
        expect(step.runs).toEqual(["cancel-plan-0"]);
        expect(step.sleepUntils).toEqual([{ name: "cancel-sleep-0", until: "2026-11-03T19:30:00.000Z" }]);
        expect(cancelSpy.mock.calls.filter((call) => call[0] === paymentIntentId)).toHaveLength(0);
        expect(cancelledPayments.has(paymentIntentId)).toBe(false);
        expect(captureCalls).toHaveLength(0);
        expect(refundRequests.filter((request) => request.paymentIntentId === paymentIntentId)).toHaveLength(0);
        const before = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(before?.status).toBe("AUTHORIZED");
        held.release();
        await finished;
        expect(step.sleepUntils).toEqual([{ name: "cancel-sleep-0", until: "2026-11-03T19:30:00.000Z" }]);
        expect(cancelSpy.mock.calls.filter((call) => call[0] === paymentIntentId)).toHaveLength(1);
        expect(cancelledPayments.has(paymentIntentId)).toBe(true);
        expect(captureCalls).toHaveLength(0);
        expect(refundRequests.filter((request) => request.paymentIntentId === paymentIntentId)).toHaveLength(0);
        const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(updated?.status).toBe("CANCELLED");
      } finally {
        held.release();
        await finished.catch(() => undefined);
        cancelSpy.mockRestore();
      }
    });

    it("a queued order is not alerted or cancelled before opening; alert and cancel fire at 15 and 30 open minutes", async () => {
      const { acceptanceAlert, autoCancel } = await import("./functions");
      // Hours 09:00–20:00 ET every day. Placed Tue 21:00 ET; checkout stored the clock at Wed 09:00 ET.
      const placedAt = "2026-11-04T02:00:00.000Z";
      const clockStartsAt = new Date("2026-11-04T14:00:00.000Z");
      const cancelSpy = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent");
      try {
        for (const timer of [
          { fn: acceptanceAlert, sleep: { name: "alert-sleep-0", until: "2026-11-04T14:15:00.000Z" } },
          { fn: autoCancel, sleep: { name: "cancel-sleep-0", until: "2026-11-04T14:30:00.000Z" } },
        ]) {
          const order = await createTestOrder();
          const authorizedAt = await authorizedAtFromPersistedCreatedAt(order.id, placedAt);
          await storeScopedTransaction(storeId, async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { acceptanceClockStartsAt: clockStartsAt } });
          });
          const step = makeFakeStep();
          const held = holdSleepUntilReleased(step);
          const finished = withMockedTime(new Date(placedAt), () =>
            getHandler(timer.fn)({ event: { data: { orderId: order.id, storeId, authorizedAt } }, step }),
          );
          try {
            await waitForSleepEntry(held.entered);
            expect(step.sleepUntils).toEqual([timer.sleep]);
            const alertsBefore = await storeScoped(storeId).auditLog.findMany({
              where: { entityId: order.id, action: "acceptance_alert", entityType: "order" },
            });
            expect(alertsBefore).toHaveLength(0);
            expect((await storeScoped(storeId).order.findUnique({ where: { id: order.id } }))?.status).toBe("AUTHORIZED");
            expect(cancelSpy.mock.calls.filter((call) => call[0] === order.paymentIntentId)).toHaveLength(0);
            held.release();
            await finished;
          } finally {
            held.release();
            await finished.catch(() => undefined);
          }
          expect(step.sleepUntils).toEqual([timer.sleep]);
          const after = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
          const alerts = await storeScoped(storeId).auditLog.findMany({
            where: { entityId: order.id, action: "acceptance_alert", entityType: "order" },
          });
          if (timer.fn === acceptanceAlert) {
            expect(alerts).toHaveLength(1);
            expect(after?.status).toBe("AUTHORIZED");
          } else {
            expect(alerts).toHaveLength(0);
            expect(after?.status).toBe("CANCELLED");
            expect(cancelSpy.mock.calls.filter((call) => call[0] === order.paymentIntentId)).toHaveLength(1);
          }
        }

        // A queued order whose hours become never-open is cancelled at the hold cap (created + 6 d 12 h).
        const capped = await createTestOrder();
        const cappedAt = await authorizedAtFromPersistedCreatedAt(capped.id, placedAt);
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({ where: { id: capped.id }, data: { acceptanceClockStartsAt: clockStartsAt } });
        });
        const step = makeFakeStep();
        const held = holdSleepUntilReleased(step);
        const finished = withMockedTime(new Date(placedAt), () =>
          getHandler(autoCancel)({ event: { data: { orderId: capped.id, storeId, authorizedAt: cappedAt } }, step }),
        );
        try {
          await waitForSleepEntry(held.entered);
          await rawPrisma.store.update({ where: { id: storeId }, data: { hours: {} } });
          held.release();
          await finished;
        } finally {
          held.release();
          await finished.catch(() => undefined);
          await rawPrisma.store.update({ where: { id: storeId }, data: { hours: WEEKDAY_HOURS } });
        }
        expect(step.sleepUntils).toEqual([
          { name: "cancel-sleep-0", until: "2026-11-04T14:30:00.000Z" },
          { name: "cancel-sleep-1", until: "2026-11-10T14:00:00.000Z" },
        ]);
        expect(cancelSpy.mock.calls.filter((call) => call[0] === capped.paymentIntentId)).toHaveLength(1);
        expect((await storeScoped(storeId).order.findUnique({ where: { id: capped.id } }))?.status).toBe("CANCELLED");
      } finally {
        cancelSpy.mockRestore();
      }
    }, 20_000);

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

    it("returns early for invalid event data (A6 guard)", async () => {
      const { autoCancel } = await import("./functions");
      const handler = getHandler(autoCancel);
      const step = makeFakeStep();

      await handler({ event: { data: { orderId: "", storeId: "" } }, step });
      expect(step.sleepNames).toHaveLength(0);
    });

    it("a recovered event sleeps until the stored deadline, not a fresh delay", async () => {
      const { acceptanceAlert, autoCancel } = await import("./functions");
      // Each event is re-sent (sweep) at `now` with a misleading authorizedAt: timing comes from the order row.
      const cases = [
        {
          label: "open store, placed 10 minutes earlier",
          createdAt: "2026-11-03T18:50:00.000Z",
          now: OPEN_AT,
          alert: [{ name: "alert-sleep-0", until: "2026-11-03T19:05:00.000Z" }],
          cancel: [{ name: "cancel-sleep-0", until: "2026-11-03T19:20:00.000Z" }],
        },
        {
          label: "placed 08:45 ET before the 09:00 opening, no stored clock",
          createdAt: "2026-11-03T13:45:00.000Z",
          now: "2026-11-03T13:50:00.000Z",
          alert: [{ name: "alert-sleep-0", until: "2026-11-03T14:15:00.000Z" }],
          cancel: [{ name: "cancel-sleep-0", until: "2026-11-03T14:30:00.000Z" }],
        },
        {
          label: "deadline already passed",
          createdAt: "2026-11-03T18:25:00.000Z",
          now: OPEN_AT,
          alert: [] as Array<{ name: string; until: string }>,
          cancel: [] as Array<{ name: string; until: string }>,
        },
      ];
      const cancelSpy = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent");
      try {
        for (const c of cases) {
          const alertOrder = await createTestOrder();
          await authorizedAtFromPersistedCreatedAt(alertOrder.id, c.createdAt);
          const alertStep = makeFakeStep();
          await withMockedTime(new Date(c.now), () =>
            getHandler(acceptanceAlert)({ event: { data: { orderId: alertOrder.id, storeId, authorizedAt: c.now } }, step: alertStep }),
          );
          expect(alertStep.sleepUntils, c.label).toEqual(c.alert);
          const alerts = await storeScoped(storeId).auditLog.findMany({
            where: { entityId: alertOrder.id, action: "acceptance_alert", entityType: "order" },
          });
          expect(alerts, c.label).toHaveLength(1);

          const cancelOrder = await createTestOrder();
          await authorizedAtFromPersistedCreatedAt(cancelOrder.id, c.createdAt);
          const cancelStep = makeFakeStep();
          await withMockedTime(new Date(c.now), () =>
            getHandler(autoCancel)({ event: { data: { orderId: cancelOrder.id, storeId, authorizedAt: c.now } }, step: cancelStep }),
          );
          expect(cancelStep.sleepUntils, c.label).toEqual(c.cancel);
          expect(cancelSpy.mock.calls.filter((call) => call[0] === cancelOrder.paymentIntentId), c.label).toHaveLength(1);
          expect((await storeScoped(storeId).order.findUnique({ where: { id: cancelOrder.id } }))?.status, c.label).toBe("CANCELLED");
        }
      } finally {
        cancelSpy.mockRestore();
      }
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

    it("cancels an ACCEPTED order 24 h after acceptance with pick_timeout; fresh and scheduled orders are untouched", async () => {
      const { sweepOrphanedAuthorized } = await import("./functions");
      const handler = (sweepOrphanedAuthorized as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;
      const hour = 3600_000;
      async function acceptedOrder(acceptedAgoMs: number, pickupSlot: string | null) {
        const order = await createTestOrder();
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: "ACCEPTED",
              createdAt: new Date(Date.now() - acceptedAgoMs - 60_000),
              acceptedAt: new Date(Date.now() - acceptedAgoMs),
              inngestEventSentAt: new Date(),
              pickupSlot,
            },
          });
        });
        return order;
      }
      const abandoned = await acceptedOrder(25 * hour, null);
      const fresh = await acceptedOrder(23 * hour, null);
      const scheduled = await acceptedOrder(25 * hour, new Date(Date.now() + 48 * hour).toISOString());

      await handler({ step: makeFakeStep() });

      const status = async (id: string) => (await storeScoped(storeId).order.findUnique({ where: { id } }))!.status;
      expect(await status(abandoned.id)).toBe("CANCELLED");
      expect(cancelledPayments.has(abandoned.paymentIntentId!)).toBe(true);
      const cause = await storeScoped(storeId).auditLog.findMany({ where: { entityId: abandoned.id, action: "pick_timeout" } });
      expect(cause).toHaveLength(1);
      expect(await status(fresh.id)).toBe("ACCEPTED");
      expect(await status(scheduled.id)).toBe("ACCEPTED");
      expect(cancelledPayments.has(fresh.paymentIntentId!)).toBe(false);
      expect(cancelledPayments.has(scheduled.paymentIntentId!)).toBe(false);
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
    const providerSpies = {
      createConnectAccount: vi.spyOn(fakeStripeProvider, "createConnectAccount"),
      createAccountLink: vi.spyOn(fakeStripeProvider, "createAccountLink"),
      getAccount: vi.spyOn(fakeStripeProvider, "getAccount"),
      verifyWebhookSignature: vi.spyOn(fakeStripeProvider, "verifyWebhookSignature"),
      capturePaymentIntent: vi.spyOn(fakeStripeProvider, "capturePaymentIntent"),
      cancelPaymentIntent: vi.spyOn(fakeStripeProvider, "cancelPaymentIntent"),
      retrievePaymentIntent: vi.spyOn(fakeStripeProvider, "retrievePaymentIntent"),
      refundPayment: vi.spyOn(fakeStripeProvider, "refundPayment"),
      listRefunds: vi.spyOn(fakeStripeProvider, "listRefunds"),
      retrieveRefund: vi.spyOn(fakeStripeProvider, "retrieveRefund"),
    };
    const clearProviderSpies = () => {
      for (const spy of Object.values(providerSpies)) spy.mockClear();
    };
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
          return { order, run: () => recordReconcileResult(storeBId, order.id) };
        },
        async () => {
          const order = await createTestOrder();
          return { order, run: () => sendOrderAuthorized(storeBId, order.id) };
        },
        async () => {
          const order = await createTestOrder();
          await storeScoped(storeId).notificationLog.createMany({
            data: [
              { storeId, orderId: order.id, event: "placed", channel: "email", status: "pending" },
              { storeId, orderId: order.id, event: "placed", channel: "sms", status: "pending" },
            ],
          });
          const { sendCustomerNotification } = await import("./functions");
          const { clearTestSentEmails, getTestSentEmails } = await import("../email/send");
          const { clearTestSentSms, getTestSentSms } = await import("../notifications/sms");
          clearTestSentEmails();
          clearTestSentSms();
          const handler = (sendCustomerNotification as unknown as {
            fn: (ctx: { event: { data: { orderId: string; storeId: string; event: string } }; step: ReturnType<typeof makeFakeStep> }) => Promise<void>;
          }).fn;
          return {
            order,
            run: async () => {
              await handler({
                event: { data: { orderId: order.id, storeId: storeBId, event: "placed" } },
                step: makeFakeStep(),
              });
              const rows = await storeScoped(storeId).notificationLog.findMany({ where: { orderId: order.id } });
              expect(rows.map((row) => row.status)).toEqual(["pending", "pending"]);
              expect(getTestSentEmails()).toHaveLength(0);
              expect(getTestSentSms()).toHaveLength(0);
            },
          };
        },
      ];
      for (const build of cases) {
        const { order, run } = await build();
        const beforeA = await orderSnapshot(storeId, order.id);
        const beforeB = await orderSnapshot(storeBId, order.id);
        const stripe = { cancelled: cancelledPayments.size, captures: captureCalls.length, sends: sendSpy.mock.calls.length };
        clearProviderSpies();
        await run();
        expect(await orderSnapshot(storeId, order.id)).toEqual(beforeA);
        expect(await orderSnapshot(storeBId, order.id)).toEqual(beforeB);
        expect(cancelledPayments.size).toBe(stripe.cancelled);
        expect(captureCalls.length).toBe(stripe.captures);
        expect(sendSpy.mock.calls.length).toBe(stripe.sends);
        for (const spy of Object.values(providerSpies)) expect(spy).not.toHaveBeenCalled();
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
      clearProviderSpies();
      await recordReconcileResult(storeId, stuck.id);
      expect(providerSpies.retrievePaymentIntent).toHaveBeenCalled();
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
      for (const spy of Object.values(providerSpies)) spy.mockRestore();
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

  it("scoped finders return no foreign order from any branch, and nothing for an empty list", async () => {
    const slug = `inngest-foreign-${Date.now()}`;
    const foreign = await rawPrisma.store.create({
      data: {
        slug,
        name: "Inngest Foreign Store",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 25,
        stripeAccountId: "acct_test_inngest_foreign",
        hours: WEEKDAY_HOURS,
        timezone: "America/New_York",
      },
    });
    try {
      const customer = await storeScoped(foreign.id).customer.create({
        data: { storeId: foreign.id, name: "Foreign Customer", email: `foreign-${Date.now()}@example.com`, phone: "+15559990001" },
      });
      const sixMinAgo = new Date(Date.now() - 6 * 60_000);
      const twoMinAgo = new Date(Date.now() - 2 * 60_000);
      async function foreignOrder(status: string, paymentIntentId: string, updatedAt: Date) {
        return storeScoped(foreign.id).order.create({
          data: {
            storeId: foreign.id,
            number: ++orderSeq,
            customerId: customer.id,
            status,
            fulfillment: "pickup",
            subtotalCents: 1000,
            bufferCents: 100,
            tipCents: 0,
            deliveryFeeCents: 0,
            totalAuthorizedCents: 1100,
            totalCents: 1000,
            paymentIntentId,
            updatedAt,
          },
        });
      }
      const cancelling = await foreignOrder("CANCELLING", `pi_foreign_cancel_${Date.now()}`, sixMinAgo);
      await storeScoped(foreign.id).order.update({ where: { id: cancelling.id }, data: { updatedAt: sixMinAgo } });
      const reservedOrder = await foreignOrder("AUTHORIZED", `pi_foreign_reserved_${Date.now()}`, twoMinAgo);
      const refundFailed = await foreignOrder("REFUND_FAILED", `pi_foreign_failed_${Date.now()}`, twoMinAgo);
      const abandonedOrder = await foreignOrder("AUTHORIZED", `pi_foreign_abandoned_${Date.now()}`, twoMinAgo);
      const orphan = await foreignOrder("AUTHORIZED", `pi_foreign_orphan_${Date.now()}`, twoMinAgo);
      await storeScoped(foreign.id).order.update({
        where: { id: orphan.id },
        data: { createdAt: new Date(Date.now() - 120_000), inngestEventSentAt: null },
      });
      await storeScoped(foreign.id).refundRequest.create({
        data: {
          storeId: foreign.id,
          orderId: reservedOrder.id,
          paymentIntentId: reservedOrder.paymentIntentId!,
          key: `refund:foreign:reserved:${reservedOrder.id}`,
          amountCents: 500,
          refundApplicationFee: false,
          state: "RESERVED",
        },
      });
      await storeScoped(foreign.id).refundRequest.create({
        data: {
          storeId: foreign.id,
          orderId: abandonedOrder.id,
          paymentIntentId: abandonedOrder.paymentIntentId!,
          key: `refund:foreign:abandoned:${abandonedOrder.id}`,
          amountCents: 500,
          refundApplicationFee: false,
          state: "ABANDONED",
        },
      });
      const foreignIds = [cancelling.id, reservedOrder.id, refundFailed.id, abandonedOrder.id];
      const stuckForeign = await realFindStuck({ storeIds: [foreign.id] });
      expect(stuckForeign.map((row) => row.id).sort()).toEqual([...foreignIds].sort());
      const stuckOwn = await realFindStuck({ storeIds: [storeId, storeBId] });
      expect(stuckOwn.map((row) => row.id).filter((id) => foreignIds.includes(id))).toEqual([]);
      expect(await realFindStuck({ storeIds: [] })).toEqual([]);
      const orphanForeign = await realFindOrphaned({ storeIds: [foreign.id] });
      expect(orphanForeign.map((row) => row.id)).toContain(orphan.id);
      const orphanOwn = await realFindOrphaned({ storeIds: [storeId, storeBId] });
      expect(orphanOwn.map((row) => row.id)).not.toContain(orphan.id);
      expect(await realFindOrphaned({ storeIds: [] })).toEqual([]);
    } finally {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.refundRequest.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.auditLog.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.orderLine.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.order.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.customer.deleteMany({ where: { storeId: foreign.id } }),
      ]);
      await rawPrisma.store.delete({ where: { id: foreign.id } });
    }
  });

  it("a scoped stuck-order sweep leaves another store's open refund request untouched", async () => {
    const { reconcileStuckTransitional } = await import("./functions");
    const handler = (reconcileStuckTransitional as unknown as { fn: (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<void> }).fn;
    const slug = `inngest-foreign-sweep-${Date.now()}`;
    const foreign = await rawPrisma.store.create({
      data: {
        slug,
        name: "Inngest Foreign Sweep Store",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 25,
        stripeAccountId: "acct_test_inngest_foreign_sweep",
        hours: WEEKDAY_HOURS,
        timezone: "America/New_York",
      },
    });
    try {
      const customer = await storeScoped(foreign.id).customer.create({
        data: { storeId: foreign.id, name: "Foreign Sweep Customer", email: `foreign-sweep-${Date.now()}@example.com`, phone: "+15559990002" },
      });
      const paymentIntentId = `pi_x_${crypto.randomUUID()}`;
      const foreignOrder = await storeScoped(foreign.id).order.create({
        data: {
          storeId: foreign.id,
          number: ++orderSeq,
          customerId: customer.id,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 1000,
          bufferCents: 100,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 1100,
          totalCents: 1000,
          paymentIntentId,
        },
      });
      await storeScoped(foreign.id).refundRequest.create({
        data: {
          storeId: foreign.id,
          orderId: foreignOrder.id,
          paymentIntentId,
          key: `refund:foreign:sweep:${foreignOrder.id}`,
          amountCents: 500,
          refundApplicationFee: false,
          state: "RESERVED",
        },
      });
      const before = await storeScoped(foreign.id).order.findUnique({ where: { id: foreignOrder.id } });
      const auditsBefore = await storeScoped(foreign.id).auditLog.count();
      const seen = await realFindStuck({ storeIds: [foreign.id] });
      expect(seen.map((row) => row.id)).toContain(foreignOrder.id);

      const own = await createTestOrder();
      const sixMinAgo = new Date(Date.now() - 6 * 60_000);
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: own.id }, data: { status: "CANCELLING", updatedAt: sixMinAgo } });
      });
      await handler({ step: makeFakeStep() });

      const after = await storeScoped(foreign.id).order.findUnique({ where: { id: foreignOrder.id } });
      expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
      expect(after!.status).toBe("AUTHORIZED");
      expect(await storeScoped(foreign.id).auditLog.count()).toBe(auditsBefore);
      const reconciled = await storeScoped(storeId).order.findUnique({ where: { id: own.id } });
      expect(reconciled!.status).toBe("CANCELLED");
    } finally {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.refundRequest.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.auditLog.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.orderLine.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.order.deleteMany({ where: { storeId: foreign.id } }),
        rawPrisma.customer.deleteMany({ where: { storeId: foreign.id } }),
      ]);
      await rawPrisma.store.delete({ where: { id: foreign.id } });
    }
  });
});

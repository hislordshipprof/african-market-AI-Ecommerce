// Real-DB integration tests for the e2e teardown sweep (#152). The sweep client connects over the
// same owner URL as CI and lanes (app_owner: not a superuser, not BYPASSRLS), where every store-owned
// table has FORCE ROW LEVEL SECURITY. Seeding and every assertion go through a platform-admin
// transaction (the asAdmin pattern from listing/actions.integration.test.ts), so a sweep that deletes
// nothing cannot pass vacuously. Two throwaway stores per run keep the shared mama-ngozi data untouched.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { deleteE2eListings } from "../../../e2e/cleanup-listings";
import { E2E_LISTING_PREFIX } from "./e2e-listings";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// Unique per run; the (store_id, number) constraint needs distinct numbers inside one store.
const RUN_BASE = 100_000 + Math.floor(Math.random() * 1_000_000_000);
const ZERO = { listings: 0, orders: 0, customers: 0 };

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function asAdmin<T>(raw: PrismaClient, op: (tx: Tx) => Promise<T>): Promise<T> {
  return raw.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return op(tx);
    },
    { timeout: 120_000 },
  ) as Promise<T>;
}

async function asStore<T>(raw: PrismaClient, storeId: string, op: (tx: Tx) => Promise<T>): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return op(tx);
  }) as Promise<T>;
}

describe.skipIf(!hasDb)("deleteE2eListings (DB integration, FORCE RLS as app_owner)", () => {
  let raw: PrismaClient;
  const slugA = `e2ec152-a-${RUN}`;
  const slugB = `e2ec152-b-${RUN}`;
  const actor = `e2ec152-u-${RUN}`;
  let storeA: string;
  let storeB: string;
  let seq = 0;
  const uid = (p: string) => `${p}-${RUN}-${++seq}`;

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
    storeA = (await raw.store.create({ data: { slug: slugA, name: "E2ec152 A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: slugB, name: "E2ec152 B", themePreset: "palm-and-shea" } })).id;
    await raw.user.create({ data: { id: actor, email: `${actor}@example.com`, name: "Actor", emailVerified: true } });
  });

  afterAll(async () => {
    if (!raw) return;
    await asAdmin(raw, async (tx) => {
      for (const storeId of [storeA, storeB]) {
        if (!storeId) continue;
        await tx.orderLine.deleteMany({ where: { storeId } });
        await tx.order.deleteMany({ where: { storeId } });
        await tx.cartLine.deleteMany({ where: { storeId } });
        await tx.cart.deleteMany({ where: { storeId } });
        await tx.customer.deleteMany({ where: { storeId } });
        await tx.stockEvent.deleteMany({ where: { storeId } });
        await tx.listing.deleteMany({ where: { storeId } });
      }
    });
    await raw.store.deleteMany({ where: { slug: { in: [slugA, slugB] } } });
    await raw.user.deleteMany({ where: { id: actor } });
    await raw.$disconnect();
  });

  /** One listing with one variant and one stock event. */
  async function seedListing(storeId: string, name: string) {
    const id = uid("l");
    const variantId = uid("v");
    await asAdmin(raw, async (tx) => {
      await tx.listing.create({
        data: { id, storeId, customName: name, price: 500, stockMode: "tracked", qty: 5 },
      });
      await tx.listingVariant.create({ data: { id: variantId, listingId: id, label: "1 lb", price: 500, weightG: 450 } });
      await tx.stockEvent.create({ data: { storeId, listingId: id, type: "adjust", delta: 5, actorId: actor } });
    });
    return { id, variantId };
  }

  async function seedCustomer(storeId: string, name = "Cust") {
    const id = uid("c");
    await asAdmin(raw, (tx) =>
      tx.customer.create({ data: { id, storeId, name, email: `${id}@example.com`, phone: "5550100" } }),
    );
    return id;
  }

  let orderNo = 0;
  /** An order in `storeId` for `customerId` with one line per variant id. */
  async function seedOrder(storeId: string, customerId: string, variantIds: string[], substituteOf?: string) {
    const id = uid("o");
    await asAdmin(raw, async (tx) => {
      await tx.order.create({
        data: {
          id,
          storeId,
          number: (RUN_BASE + ++orderNo),
          customerId,
          subtotalCents: 500,
          bufferCents: 0,
          totalAuthorizedCents: 500,
        },
      });
      for (const v of variantIds) {
        await tx.orderLine.create({
          data: { storeId, orderId: id, listingVariantId: v, substituteVariantId: substituteOf, qtyOrdered: 1, unitPriceCents: 500 },
        });
      }
    });
    return id;
  }

  async function seedCart(storeId: string, customerId: string | null, variantId?: string) {
    const id = uid("k");
    await asAdmin(raw, async (tx) => {
      await tx.cart.create({ data: { id, storeId, customerId } });
      if (variantId) await tx.cartLine.create({ data: { storeId, cartId: id, variantId, qty: 1 } });
    });
    return id;
  }

  const exists = (storeId: string) => ({
    listing: (id: string) => asAdmin(raw, async (tx) => (await tx.listing.count({ where: { storeId, id } })) === 1),
    order: (id: string) => asAdmin(raw, async (tx) => (await tx.order.count({ where: { storeId, id } })) === 1),
    customer: (id: string) => asAdmin(raw, async (tx) => (await tx.customer.count({ where: { storeId, id } })) === 1),
    orderLines: (orderId: string) => asAdmin(raw, (tx) => tx.orderLine.count({ where: { storeId, orderId } })),
    cart: (id: string) => asAdmin(raw, async (tx) => (await tx.cart.count({ where: { storeId, id } })) === 1),
  });
  const inA = () => exists(storeA);
  const inB = () => exists(storeB);

  const sweepA = (opts: { names?: string[] } = {}) => deleteE2eListings({ ...opts, storeSlug: slugA });
  const nm = (s: string) => `${E2E_LISTING_PREFIX}${s} ${RUN}-${++seq}`;

  /** Remove everything prefixed in store A so each test starts clean. */
  async function resetA() {
    await sweepA();
  }

  it("removes an order whose only lines were e2e, and its orphaned customer (scenario 1, edge 5)", async () => {
    await resetA();
    const l = await seedListing(storeA, nm("only"));
    const c = await seedCustomer(storeA);
    const o = await seedOrder(storeA, c, [l.variantId]);
    const res = await sweepA();
    expect(res.listings).toBeGreaterThan(0);
    expect(res.orders).toBe(1);
    expect(res.customers).toBe(1);
    expect(await inA().listing(l.id)).toBe(false);
    expect(await inA().order(o)).toBe(false);
    expect(await inA().orderLines(o)).toBe(0);
    expect(await inA().customer(c)).toBe(false);
  });

  it("keeps a mixed order with its non-e2e line (scenario 2, edge 6)", async () => {
    await resetA();
    const e = await seedListing(storeA, nm("mix"));
    const real = await seedListing(storeA, "Seeded Plantain " + RUN);
    const c = await seedCustomer(storeA);
    const o = await seedOrder(storeA, c, [e.variantId, real.variantId]);
    const res = await sweepA();
    expect(res.orders).toBe(0);
    expect(res.customers).toBe(0);
    expect(await inA().order(o)).toBe(true);
    expect(await inA().orderLines(o)).toBe(1);
    expect(await inA().customer(c)).toBe(true);
    expect(await inA().listing(real.id)).toBe(true);
  });

  it("keeps a customer who has another order or a cart (scenario 3, edge 8)", async () => {
    await resetA();
    const real = await seedListing(storeA, "Seeded Yam " + RUN);
    const e = await seedListing(storeA, nm("hist"));
    const withOrder = await seedCustomer(storeA);
    const withCart = await seedCustomer(storeA);
    const o1 = await seedOrder(storeA, withOrder, [e.variantId]);
    const other = await seedOrder(storeA, withOrder, [real.variantId]);
    const o2 = await seedOrder(storeA, withCart, [e.variantId]);
    await seedCart(storeA, withCart);
    const res = await sweepA();
    expect(res.orders).toBe(2);
    expect(res.customers).toBe(0);
    expect(await inA().order(o1)).toBe(false);
    expect(await inA().order(o2)).toBe(false);
    expect(await inA().order(other)).toBe(true);
    expect(await inA().customer(withOrder)).toBe(true);
    expect(await inA().customer(withCart)).toBe(true);
  });

  it("deletes the order when its only line goes because an e2e listing was its substitute (edge 7)", async () => {
    await resetA();
    const real = await seedListing(storeA, "Seeded Rice " + RUN);
    const e = await seedListing(storeA, nm("sub"));
    const c = await seedCustomer(storeA);
    const o = await seedOrder(storeA, c, [real.variantId], e.variantId);
    const res = await sweepA();
    expect(res.orders).toBe(1);
    expect(await inA().order(o)).toBe(false);
    expect(await inA().listing(real.id)).toBe(true);
  });

  it("removes cart lines on e2e listings but leaves the cart (out of scope)", async () => {
    await resetA();
    const e = await seedListing(storeA, nm("cart"));
    const k = await seedCart(storeA, null, e.variantId);
    await sweepA();
    expect(await inA().cart(k)).toBe(true);
    expect(await asAdmin(raw, (tx) => tx.cartLine.count({ where: { cartId: k } }))).toBe(0);
  });

  it("does not delete orders that were already empty or untouched (edge 9)", async () => {
    await resetA();
    await seedListing(storeA, nm("noop"));
    const c = await seedCustomer(storeA);
    const empty = await seedOrder(storeA, c, []);
    const res = await sweepA();
    expect(res).toEqual({ listings: 1, orders: 0, customers: 0 });
    expect(await inA().order(empty)).toBe(true);
    expect(await inA().customer(c)).toBe(true);
  });

  it("per-spec path removes only the named listings and the orders and customers they empty (scenario 5)", async () => {
    await resetA();
    const nameKeep = nm("keep");
    const nameGo = nm("go");
    const keep = await seedListing(storeA, nameKeep);
    const go = await seedListing(storeA, nameGo);
    const cKeep = await seedCustomer(storeA);
    const cGo = await seedCustomer(storeA);
    const oKeep = await seedOrder(storeA, cKeep, [keep.variantId]);
    const oGo = await seedOrder(storeA, cGo, [go.variantId]);
    const res = await sweepA({ names: [nameGo] });
    expect(res).toEqual({ listings: 1, orders: 1, customers: 1 });
    expect(await inA().listing(go.id)).toBe(false);
    expect(await inA().order(oGo)).toBe(false);
    expect(await inA().customer(cGo)).toBe(false);
    expect(await inA().listing(keep.id)).toBe(true);
    expect(await inA().order(oKeep)).toBe(true);
    expect(await inA().orderLines(oKeep)).toBe(1);
    expect(await inA().customer(cKeep)).toBe(true);
  });

  it("full sweep removes rows under FORCE RLS and leaves no prefixed listing (scenario 4)", async () => {
    await resetA();
    await seedListing(storeA, nm("a"));
    await seedListing(storeA, nm("b"));
    const res = await sweepA();
    expect(res.listings).toBe(2);
    const left = await asAdmin(raw, (tx) =>
      tx.listing.count({ where: { storeId: storeA, customName: { startsWith: E2E_LISTING_PREFIX } } }),
    );
    expect(left).toBe(0);
  });

  it("sweeping twice is a no-op the second time (edge 1)", async () => {
    await resetA();
    const l = await seedListing(storeA, nm("twice"));
    const c = await seedCustomer(storeA);
    await seedOrder(storeA, c, [l.variantId]);
    await sweepA();
    expect(await sweepA()).toEqual(ZERO);
  });

  it("two overlapping sweeps both finish and each row is deleted once (edge 2)", async () => {
    await resetA();
    const names = [nm("c1"), nm("c2"), nm("c3")];
    for (const n of names) {
      const l = await seedListing(storeA, n);
      const c = await seedCustomer(storeA);
      await seedOrder(storeA, c, [l.variantId]);
    }
    const results = await Promise.allSettled([sweepA({ names }), sweepA({ names })]);
    for (const r of results) expect(r.status).toBe("fulfilled");
    const total = (k: "listings" | "orders" | "customers") =>
      results.reduce((n, r) => n + (r.status === "fulfilled" ? r.value[k] : 0), 0);
    expect(total("listings")).toBe(3);
    expect(total("orders")).toBe(3);
    expect(total("customers")).toBe(3);
  });

  it("rolls the whole sweep back when a later delete fails (edge 3)", async () => {
    await resetA();
    const l = await seedListing(storeA, nm("boom"));
    // Static DDL (no interpolation): the trigger only fires for customers named like this.
    const poison = `e2ec152-boom-${RUN}`;
    const c = await seedCustomer(storeA, poison);
    const o = await seedOrder(storeA, c, [l.variantId]);
    await raw.$executeRaw`CREATE OR REPLACE FUNCTION e2ec152_block_customer_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked customer delete'; END $$`;
    await raw.$executeRaw`CREATE TRIGGER e2ec152_block_customer_delete BEFORE DELETE ON customers FOR EACH ROW WHEN (OLD.name LIKE 'e2ec152-boom-%') EXECUTE FUNCTION e2ec152_block_customer_delete()`;
    try {
      await expect(sweepA()).rejects.toThrow();
      expect(await inA().listing(l.id)).toBe(true);
      expect(await inA().order(o)).toBe(true);
      expect(await inA().orderLines(o)).toBe(1);
      expect(await inA().customer(c)).toBe(true);
    } finally {
      await raw.$executeRaw`DROP TRIGGER e2ec152_block_customer_delete ON customers`;
      await raw.$executeRaw`DROP FUNCTION e2ec152_block_customer_delete()`;
    }
    await sweepA();
  });

  it("empty or unprefixed names delete nothing and never widen to a full sweep (edge 12)", async () => {
    await resetA();
    const e = await seedListing(storeA, nm("safe"));
    const real = await seedListing(storeA, "Seeded Okra " + RUN);
    expect(await sweepA({ names: [] })).toEqual(ZERO);
    expect(await sweepA({ names: ["Seeded Okra " + RUN] })).toEqual(ZERO);
    expect(await inA().listing(e.id)).toBe(true);
    expect(await inA().listing(real.id)).toBe(true);
  });

  it("handles ~500 e2e listings with orders inside the transaction timeout (edge 13)", async () => {
    await resetA();
    const N = 500;
    const listings = Array.from({ length: N }, (_, i) => ({
      id: uid("bl"),
      storeId: storeA,
      customName: `${E2E_LISTING_PREFIX}bulk ${RUN} ${i}`,
      price: 500,
      stockMode: "tracked",
      qty: 1,
    }));
    const variants = listings.map((l) => ({ id: `${l.id}-v`, listingId: l.id, label: "1", price: 500, weightG: 100 }));
    const customers = listings.map((l) => ({
      id: `${l.id}-c`,
      storeId: storeA,
      name: "Bulk",
      email: `${l.id}@example.com`,
      phone: "5550100",
    }));
    const base = RUN_BASE + 10_000 + orderNo;
    orderNo += N;
    const orders = listings.map((l, i) => ({
      id: `${l.id}-o`,
      storeId: storeA,
      number: base + i,
      customerId: `${l.id}-c`,
      subtotalCents: 500,
      bufferCents: 0,
      totalAuthorizedCents: 500,
    }));
    const lines = listings.map((l) => ({
      storeId: storeA,
      orderId: `${l.id}-o`,
      listingVariantId: `${l.id}-v`,
      qtyOrdered: 1,
      unitPriceCents: 500,
    }));
    await asAdmin(raw, async (tx) => {
      await tx.listing.createMany({ data: listings });
      await tx.listingVariant.createMany({ data: variants });
      await tx.customer.createMany({ data: customers });
      await tx.order.createMany({ data: orders });
      await tx.orderLine.createMany({ data: lines });
    });
    const res = await sweepA();
    expect(res).toEqual({ listings: N, orders: N, customers: N });
  }, 120_000);

  it("returns zeros when the e2e store does not exist (edge 14)", async () => {
    expect(await deleteE2eListings({ storeSlug: `nope-${RUN}` })).toEqual(ZERO);
  });

  it("fails fast with the resolveDirectUrl error when no direct URL is set (edge 15)", async () => {
    const saved = { u: process.env.DATABASE_URL_UNPOOLED, d: process.env.DIRECT_URL };
    delete process.env.DATABASE_URL_UNPOOLED;
    delete process.env.DIRECT_URL;
    try {
      await expect(deleteE2eListings({ storeSlug: slugA })).rejects.toThrow(/Neither DATABASE_URL_UNPOOLED nor DIRECT_URL/);
    } finally {
      if (saved.u !== undefined) process.env.DATABASE_URL_UNPOOLED = saved.u;
      if (saved.d !== undefined) process.env.DIRECT_URL = saved.d;
    }
  });

  it("a store-A sweep leaves every store-B row intact (edge 10)", async () => {
    await resetA();
    const bName = nm("b-same");
    const lB = await seedListing(storeB, bName);
    const cB = await seedCustomer(storeB);
    const oB = await seedOrder(storeB, cB, [lB.variantId]);
    const kB = await seedCart(storeB, null, lB.variantId);
    const lA = await seedListing(storeA, bName);
    const cA = await seedCustomer(storeA);
    const oA = await seedOrder(storeA, cA, [lA.variantId]);
    const res = await sweepA();
    expect(res).toEqual({ listings: 1, orders: 1, customers: 1 });
    expect(await inA().order(oA)).toBe(false);
    expect(await inB().listing(lB.id)).toBe(true);
    expect(await inB().order(oB)).toBe(true);
    expect(await inB().orderLines(oB)).toBe(1);
    expect(await inB().customer(cB)).toBe(true);
    expect(await inB().cart(kB)).toBe(true);
    expect(await asAdmin(raw, (tx) => tx.cartLine.count({ where: { cartId: kB } }))).toBe(1);
    expect(await asAdmin(raw, (tx) => tx.stockEvent.count({ where: { storeId: storeB, listingId: lB.id } }))).toBe(1);
    expect(await asAdmin(raw, (tx) => tx.listingVariant.count({ where: { id: lB.variantId } }))).toBe(1);
    await deleteE2eListings({ storeSlug: slugB });
  });

  /**
   * Wraps the real interactive transaction so `hook` runs right after `model.method` returns, before the
   * sweep continues. No DB result is replaced; the hook only schedules a competing writer.
   */
  function hookClient(
    model: "order" | "customer" | "cart" | "cartLine",
    method: "findMany" | "deleteMany",
    hook: () => Promise<void>,
  ): PrismaClient {
    const wrapDelegate = (d: object) =>
      new Proxy(d, {
        get(t, m) {
          const f = Reflect.get(t, m, t) as (...a: unknown[]) => Promise<unknown>;
          if (m !== method) return typeof f === "function" ? f.bind(t) : f;
          return async (...a: unknown[]) => {
            const r = await f.apply(t, a);
            await hook();
            return r;
          };
        },
      });
    const wrapTx = (tx: Tx) =>
      new Proxy(tx, {
        get(t, p) {
          const v = Reflect.get(t, p, t);
          if (p === model) return wrapDelegate(v as object);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === "$transaction") {
          return (fn: (tx: Tx) => Promise<unknown>, opts: unknown) =>
            (target.$transaction as (f: unknown, o: unknown) => Promise<unknown>)((tx: Tx) => fn(wrapTx(tx)), opts);
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as PrismaClient;
  }

  /** Both sweeps wait here until each has arrived, or 1.5 s pass (a sweep serialized behind a lock never arrives). */
  function barrierClient(model: "order" | "customer", method: "findMany" | "deleteMany", barrier: { n: number; waiters: Array<() => void> }) {
    return hookClient(model, method, () =>
      new Promise<void>((resolve) => {
        barrier.n += 1;
        barrier.waiters.push(resolve);
        if (barrier.n >= 2) barrier.waiters.splice(0).forEach((w) => w());
        else setTimeout(resolve, 1500);
      }),
    );
  }

  function isForeignKeyRejection(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as {
      code?: string;
      message?: string;
      meta?: { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } };
    };
    if (e.code === "P2003") return true;
    if (typeof e.message === "string" && /foreign key constraint/i.test(e.message)) return true;
    const cause = e.meta?.driverAdapterError?.cause;
    return cause?.originalCode === "23503" || cause?.kind === "ForeignKeyConstraintViolation";
  }

  /**
   * Starts a competing committed write from the hook and waits up to 1.5 s for it. A correct sweep holds
   * row locks, so the writer blocks (never settles inside the window) and then fails its FK once the sweep
   * commits; an unlocked sweep lets it commit mid-sweep. The promise stays rejected or fulfilled so the
   * test can require that foreign-key failure or a real insert. Any other error fails the test.
   */
  function racingWrite(write: () => Promise<unknown>) {
    const state: { outcome?: Promise<unknown> } = {};
    const hook = async () => {
      const pending = write();
      state.outcome = pending;
      await Promise.race([pending.then(() => undefined, () => undefined), new Promise((r) => setTimeout(r, 1500))]);
    };
    return { state, hook };
  }

  async function writerOutcome(outcome: Promise<unknown> | undefined): Promise<"committed" | "foreign-key"> {
    expect(outcome, "competing writer never started").toBeDefined();
    try {
      await outcome;
      return "committed";
    } catch (err) {
      if (!isForeignKeyRejection(err)) throw err;
      return "foreign-key";
    }
  }

  it("a normal line added to an emptied order mid-sweep is never cascaded away (AD2)", async () => {
    await resetA();
    const e = await seedListing(storeA, nm("late-line"));
    const real = await seedListing(storeA, "Seeded Late " + RUN);
    const c = await seedCustomer(storeA);
    const o = await seedOrder(storeA, c, [e.variantId]);
    const { state, hook } = racingWrite(() =>
      asStore(raw, storeA, (tx) =>
        tx.orderLine.create({
          data: { storeId: storeA, orderId: o, listingVariantId: real.variantId, qtyOrdered: 1, unitPriceCents: 500 },
        }),
      ),
    );
    await deleteE2eListings({ storeSlug: slugA, client: hookClient("order", "findMany", hook) });
    const outcome = await writerOutcome(state.outcome);
    if (outcome === "committed") {
      expect(await inA().order(o)).toBe(true);
      expect(await inA().orderLines(o)).toBe(1);
    } else {
      expect(await inA().order(o)).toBe(false);
    }
  });

  it("a store-B cart created for the customer mid-sweep keeps its customer (SP1/AD1)", async () => {
    await resetA();
    const e = await seedListing(storeA, nm("late-cart"));
    const c = await seedCustomer(storeA);
    await seedOrder(storeA, c, [e.variantId]);
    const kB = uid("kb");
    const { state, hook } = racingWrite(() =>
      asStore(raw, storeB, (tx) => tx.cart.create({ data: { id: kB, storeId: storeB, customerId: c } })),
    );
    await deleteE2eListings({ storeSlug: slugA, client: hookClient("cart", "findMany", hook) });
    const outcome = await writerOutcome(state.outcome);
    const cart = await asAdmin(raw, (tx) => tx.cart.findUnique({ where: { id: kB } }));
    if (outcome === "committed") {
      expect(cart?.customerId).toBe(c);
      expect(await inA().customer(c)).toBe(true);
    } else {
      expect(cart).toBeNull();
    }
    await asAdmin(raw, (tx) => tx.cart.deleteMany({ where: { id: kB } }));
  });

  it("concurrent sweeps with different names still remove the order they jointly empty (AD2)", async () => {
    await resetA();
    const n1 = nm("j1");
    const n2 = nm("j2");
    const l1 = await seedListing(storeA, n1);
    const l2 = await seedListing(storeA, n2);
    const c = await seedCustomer(storeA);
    const o = await seedOrder(storeA, c, [l1.variantId, l2.variantId]);
    const barrier = { n: 0, waiters: [] as Array<() => void> };
    await Promise.all([
      deleteE2eListings({ names: [n1], storeSlug: slugA, client: barrierClient("order", "findMany", barrier) }),
      deleteE2eListings({ names: [n2], storeSlug: slugA, client: barrierClient("order", "findMany", barrier) }),
    ]);
    expect(await inA().orderLines(o)).toBe(0);
    expect(await inA().order(o)).toBe(false);
    expect(await inA().customer(c)).toBe(false);
  });

  it("concurrent sweeps still remove a customer whose two orders are emptied separately (AD2)", async () => {
    await resetA();
    const n1 = nm("k1");
    const n2 = nm("k2");
    const l1 = await seedListing(storeA, n1);
    const l2 = await seedListing(storeA, n2);
    const c = await seedCustomer(storeA);
    await seedOrder(storeA, c, [l1.variantId]);
    await seedOrder(storeA, c, [l2.variantId]);
    const barrier = { n: 0, waiters: [] as Array<() => void> };
    await Promise.all([
      deleteE2eListings({ names: [n1], storeSlug: slugA, client: barrierClient("customer", "deleteMany", barrier) }),
      deleteE2eListings({ names: [n2], storeSlug: slugA, client: barrierClient("customer", "deleteMany", barrier) }),
    ]);
    expect(await inA().customer(c)).toBe(false);
  });

  it("keeps a customer that a cart in another store references (AD1)", async () => {
    await resetA();
    const l = await seedListing(storeA, nm("xcart"));
    const c = await seedCustomer(storeA);
    await seedOrder(storeA, c, [l.variantId]);
    const kB = uid("kb");
    // The single-column carts.customer_id FK accepts a store-B cart pointing at a store-A customer.
    await asStore(raw, storeB, (tx) => tx.cart.create({ data: { id: kB, storeId: storeB, customerId: c } }));
    await sweepA();
    expect(await inA().customer(c)).toBe(true);
    const cart = await asAdmin(raw, (tx) => tx.cart.findUnique({ where: { id: kB } }));
    expect(cart?.customerId).toBe(c);
    await asAdmin(raw, (tx) => tx.cart.deleteMany({ where: { id: kB } }));
  });

  // The line delete is one statement (DELETE ... RETURNING order_id). This hook commits an order
  // on the swept variant after the sweep has started and before that delete: the window a separate
  // findMany used to miss. The emptied order and its customer must go. A retry stays at zero.
  it("full sweep removes an order committed between discovery and the line delete", async () => {
    await resetA();
    const e = await seedListing(storeA, nm("late-discovery"));
    const c = await seedCustomer(storeA);
    let lateOrder = "";
    const result = await deleteE2eListings({
      storeSlug: slugA,
      client: hookClient("cartLine", "deleteMany", async () => {
        lateOrder = await seedOrder(storeA, c, [e.variantId]);
      }),
    });
    expect(lateOrder).not.toBe("");
    expect(result).toEqual({ listings: 1, orders: 1, customers: 1 });
    expect(await inA().order(lateOrder)).toBe(false);
    expect(await inA().orderLines(lateOrder)).toBe(0);
    expect(await inA().customer(c)).toBe(false);
    expect(await sweepA()).toEqual(ZERO);
  });

  it("named sweep removes an order committed between discovery and the line delete", async () => {
    await resetA();
    const name = nm("late-named");
    const otherName = nm("late-named-keep");
    const e = await seedListing(storeA, name);
    const other = await seedListing(storeA, otherName);
    const c = await seedCustomer(storeA);
    const cOther = await seedCustomer(storeA);
    const oOther = await seedOrder(storeA, cOther, [other.variantId]);
    let lateOrder = "";
    const result = await deleteE2eListings({
      names: [name],
      storeSlug: slugA,
      client: hookClient("cartLine", "deleteMany", async () => {
        lateOrder = await seedOrder(storeA, c, [e.variantId]);
      }),
    });
    expect(lateOrder).not.toBe("");
    expect(result).toEqual({ listings: 1, orders: 1, customers: 1 });
    expect(await inA().order(lateOrder)).toBe(false);
    expect(await inA().customer(c)).toBe(false);
    expect(await inA().listing(other.id)).toBe(true);
    expect(await inA().order(oOther)).toBe(true);
    expect(await inA().orderLines(oOther)).toBe(1);
    expect(await inA().customer(cOther)).toBe(true);
    expect(await sweepA({ names: [name] })).toEqual(ZERO);
    expect(await inA().order(oOther)).toBe(true);
  });

  it("disconnects only a client it created, never an injected one (ST2)", async () => {
    await resetA();
    let disconnects = 0;
    const spy = new Proxy(raw, {
      get(t, p) {
        if (p === "$disconnect") return async () => void (disconnects += 1);
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as unknown as PrismaClient;
    await seedListing(storeA, nm("lc"));
    await deleteE2eListings({ storeSlug: slugA, client: spy });
    const failing = new Proxy(spy, {
      get: (t, p) => (p === "$transaction" ? () => Promise.reject(new Error("boom")) : Reflect.get(t, p, t)),
    }) as unknown as PrismaClient;
    await expect(deleteE2eListings({ storeSlug: slugA, client: failing })).rejects.toThrow("boom");
    expect(disconnects).toBe(0);
  });

  it("with app.store_id = A, deleting store-B orders and customers affects 0 rows and creating one fails WITH CHECK", async () => {
    const lB = await seedListing(storeB, "Seeded B " + RUN);
    const cB = await seedCustomer(storeB);
    const oB = await seedOrder(storeB, cB, [lB.variantId]);
    const out = await asStore(raw, storeA, async (tx) => ({
      orders: (await tx.order.deleteMany({ where: { storeId: storeB } })).count,
      lines: (await tx.orderLine.deleteMany({ where: { storeId: storeB } })).count,
      customers: (await tx.customer.deleteMany({ where: { storeId: storeB } })).count,
    }));
    expect(out).toEqual({ orders: 0, lines: 0, customers: 0 });
    expect(await inB().order(oB)).toBe(true);
    expect(await inB().customer(cB)).toBe(true);
    await expect(
      asStore(raw, storeA, (tx) =>
        tx.customer.create({ data: { id: uid("x"), storeId: storeB, name: "X", email: "x@example.com", phone: "1" } }),
      ),
    ).rejects.toThrow();
  });
});

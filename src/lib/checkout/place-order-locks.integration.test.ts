import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { Client } from "pg";
import { healthQueryRaw, storeScoped, storeScopedTransaction } from "../db";
import { addLine } from "../cart/service";
import { acceptOrder } from "../order/service";
import { updateListing, updateVariants, type Actor, type SaveVariantInput } from "../listing/service";
import {
  computeQuote,
  recordAuthorizedOrder,
  type AuthorizedOrderLine,
  type RecordAuthorizedOrderInput,
} from "./service";
import type { Contact } from "../customer-flow/contracts";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";

const hasDb = !!process.env.DATABASE_URL;

it("runs against a database in CI", () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required; this test must not skip");
  }
  expect(process.env.DATABASE_URL.length).toBeGreaterThan(0);
});

const CONTACT: Contact = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t236.test" };
const PRICE = 500;

describe.skipIf(!hasDb)("placeOrder lock order (lane DB, app_runtime)", () => {
  let raw: PrismaClient;
  let monitor: Client;
  const storeIds: string[] = [];
  let userId = "";
  let actor: Actor;

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    monitor = new Client({ connectionString: process.env.DATABASE_URL });
    await monitor.connect();
    const user = await raw.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `t236-${Date.now().toString(36)}@example.com`,
        name: "Lock Tester",
        emailVerified: true,
      },
    });
    userId = user.id;
    actor = { id: user.id, email: user.email };
  }, 30_000);

  afterAll(async () => {
    if (raw && storeIds.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.cartLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.cart.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.order.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.customer.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.auditLog.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.stockEvent.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: storeIds } } } }),
        raw.listing.deleteMany({ where: { storeId: { in: storeIds } } }),
      ]);
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    }
    if (userId) await raw.user.deleteMany({ where: { id: userId } });
    await monitor?.end().catch(() => undefined);
    await raw?.$disconnect();
  }, 30_000);

  async function poll(label: string, pred: () => Promise<boolean>, budgetMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
      if (await pred()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out: ${label}`);
  }

  function parseCtid(ctid: string): { page: number; tuple: number } {
    const match = /^\((\d+),(\d+)\)$/.exec(ctid);
    if (!match) throw new Error(`unexpected ctid ${ctid}`);
    return { page: Number(match[1]), tuple: Number(match[2]) };
  }

  function hold(
    storeId: string,
    work: (client: Client) => Promise<void>,
  ): { release: () => void; done: Promise<unknown>; ready: () => Promise<number> } {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pid = 0;
    let armed = false;
    let holderError: unknown = null;
    const done = (async () => {
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_user");
        await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
        await client.query("SET LOCAL statement_timeout = '30s'");
        const who = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        pid = Number(who.rows[0]?.pid ?? 0);
        await work(client);
        armed = true;
        await gate;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        await client.end().catch(() => undefined);
      }
    })().catch((err: unknown) => {
      holderError = err;
      release();
      throw err;
    });
    return {
      release,
      done,
      ready: async () => {
        await poll("holder armed", async () => armed || holderError !== null);
        if (holderError) throw holderError;
        return pid;
      },
    };
  }

  async function waitersOfHolder(holderPid: number, relation: string, page: number, tuple: number): Promise<number[]> {
    const res = await monitor.query<{ pid: number }>(
      `SELECT DISTINCT pid FROM (
         SELECT l.pid
         FROM pg_locks l
         WHERE NOT l.granted
           AND l.pid <> $1
           AND l.locktype = 'transactionid'
           AND l.transactionid IN (
             SELECT h.transactionid FROM pg_locks h
             WHERE h.pid = $1 AND h.granted AND h.locktype = 'transactionid'
           )
         UNION
         SELECT l.pid
         FROM pg_locks l
         WHERE NOT l.granted
           AND l.pid <> $1
           AND l.locktype = 'tuple'
           AND l.relation = $2::regclass
           AND l.page = $3
           AND l.tuple = $4
       ) w`,
      [holderPid, relation, page, tuple],
    );
    return res.rows.map((row) => Number(row.pid));
  }

  function pgCode(err: unknown): string | undefined {
    return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : undefined;
  }

  async function pidsWaitingOn(blockerPid: number): Promise<number[]> {
    const res = await monitor.query<{ pid: number }>(
      `SELECT DISTINCT l.pid
       FROM pg_locks l
       WHERE NOT l.granted
         AND l.locktype = 'transactionid'
         AND l.transactionid IN (
           SELECT h.transactionid FROM pg_locks h
           WHERE h.pid = $1 AND h.granted AND h.locktype = 'transactionid'
         )`,
      [blockerPid],
    );
    return res.rows.map((row) => Number(row.pid));
  }

  async function pidsBlockedBy(holderPid: number): Promise<number[]> {
    const res = await monitor.query<{ pid: number }>(
      `SELECT DISTINCT l.pid
       FROM pg_locks l
       WHERE NOT l.granted
         AND $1 = ANY(pg_blocking_pids(l.pid))`,
      [holderPid],
    );
    return res.rows.map((row) => Number(row.pid));
  }

  async function assertCartHeldBy(storeId: string, cartId: string, ownerPid: number) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    let probePid = 0;
    let probeError: unknown = null;
    const done = (async () => {
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_user");
        await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
        await client.query("SET LOCAL lock_timeout = '3s'");
        const who = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        probePid = Number(who.rows[0]?.pid ?? 0);
        await client.query("SELECT id FROM carts WHERE id = $1 FOR UPDATE", [cartId]);
        probeError = new Error("cart row lock was free");
      } catch (err) {
        const code = pgCode(err);
        if (code !== "55P03" && code !== "57014") probeError = err;
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end().catch(() => undefined);
      }
    })();
    let sawWait = false;
    const waiting = poll(
      "cart probe waits on the transaction that owns the cart",
      async () => probePid > 0 && (await waitsOn(probePid, ownerPid)),
      4_000,
    ).then(() => {
      sawWait = true;
    });
    try {
      await Promise.race([waiting, done]);
    } finally {
      if (probePid > 0) await monitor.query("SELECT pg_cancel_backend($1::int)", [probePid]).catch(() => undefined);
      await done;
    }
    if (probeError) throw probeError;
    if (!sawWait) throw new Error("cart probe ended before it waited on the owner");
  }

  async function waitsOn(waiterPid: number, blockerPid: number): Promise<boolean> {
    const res = await monitor.query<{ ok: boolean }>(
      `SELECT (
         $2 = ANY(pg_blocking_pids($1))
         OR EXISTS (
           SELECT 1 FROM pg_locks w
           WHERE w.pid = $1 AND NOT w.granted AND w.locktype = 'transactionid'
             AND w.transactionid IN (
               SELECT h.transactionid FROM pg_locks h
               WHERE h.pid = $2 AND h.granted AND h.locktype = 'transactionid'
             )
         )
       ) AS ok`,
      [waiterPid, blockerPid],
    );
    return Boolean(res.rows[0]?.ok);
  }

  async function makeStore(label: string): Promise<string> {
    const store = await raw.store.create({
      data: {
        slug: `t236-${label}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`,
        name: `Lock ${label}`,
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_t236_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeIds.push(store.id);
    return store.id;
  }

  async function makeVariants(storeId: string, count: number, price = PRICE) {
    const scoped = storeScoped(storeId);
    const listing = await scoped.listing.create({
      data: {
        storeId,
        customName: `Pack ${count}`,
        price,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variants = [];
    for (let i = 0; i < count; i++) {
      variants.push(
        await scoped.listingVariant.create({
          data: { listingId: listing.id, label: `V${i}`, price, weightG: 100 + i },
        }),
      );
    }
    return { listing, variants };
  }

  async function makeCart(
    storeId: string,
    variantIds: string[],
    qty: number,
    paymentIntentId: string,
    substituteVariantId: string | null = null,
  ) {
    const scoped = storeScoped(storeId);
    const cart = await scoped.cart.create({
      data: { storeId, paymentIntentId },
    });
    const lines = [];
    for (const variantId of variantIds) {
      lines.push(
        await scoped.cartLine.create({
          data: {
            storeId,
            cartId: cart.id,
            variantId,
            qty,
            swapRule: substituteVariantId ? "named_substitute" : "exact_only",
            substituteVariantId,
          },
        }),
      );
    }
    return { cart, lines };
  }

  function orderLines(variantIds: string[], qty: number, price = PRICE, substituteVariantId: string | null = null): AuthorizedOrderLine[] {
    return variantIds.map((variantId) => ({
      variantId,
      qty,
      price,
      swapRule: substituteVariantId ? "named_substitute" : "exact_only",
      substituteVariantId,
    }));
  }

  function orderInput(
    cartId: string,
    paymentIntentId: string,
    lines: AuthorizedOrderLine[],
    email = CONTACT.email,
  ): RecordAuthorizedOrderInput {
    const quote = computeQuote(
      0,
      lines.map((line) => ({ price: line.price, qty: line.qty, maxPerOrder: null })),
      { ...CONTACT, email },
      "pickup", ADR_0021_SERVICE_FEE,
    );
    return {
      cartId,
      contact: { ...CONTACT, email },
      fulfillment: "pickup",
      pickupSlot: null,
      notes: null,
      paymentIntentId,
      quote,
      lines,
    };
  }

  async function rowCtid(storeId: string, table: "stores" | "carts" | "cart_lines", id: string): Promise<string> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      const column = table === "stores" ? "id" : "id";
      const res = await client.query<{ ctid: string }>(
        `SELECT ctid::text AS ctid FROM ${table} WHERE ${column} = $1`,
        [id],
      );
      await client.query("ROLLBACK");
      if (res.rowCount !== 1) throw new Error(`expected one ${table} row`);
      return res.rows[0]!.ctid;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  it("the checkout transaction runs as app_runtime", async () => {
    const login = (await healthQueryRaw`SELECT current_user, session_user`) as Array<{
      current_user: string;
      session_user: string;
    }>;
    expect(login[0]?.current_user).toBe("app_runtime");
    expect(login[0]?.session_user).toBe("app_runtime");
    const storeId = await makeStore("role");
    const inside = await storeScopedTransaction(storeId, async (tx) => {
      return tx.$queryRaw<Array<{ session_user: string; current_user: string; store: string }>>`
        SELECT session_user, current_user, current_setting('app.store_id') AS store
      `;
    });
    expect(inside[0]?.session_user).toBe("app_runtime");
    expect(inside[0]?.current_user).toBe("app_user");
    expect(inside[0]?.store).toBe(storeId);
  });

  it("hosted CI records orders without Stripe under the scoped runtime role", async () => {
    const storeId = await makeStore("hosted");
    const { variants } = await makeVariants(storeId, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variants[0]!.id], 1, paymentIntentId);
    const inside = await storeScopedTransaction(storeId, async (tx) => {
      return tx.$queryRaw<Array<{ session_user: string; current_user: string; store: string }>>`
        SELECT session_user, current_user, current_setting('app.store_id') AS store
      `;
    });
    expect(inside[0]).toEqual({
      session_user: "app_runtime",
      current_user: "app_user",
      store: storeId,
    });
    const recorded = await recordAuthorizedOrder(
      storeId,
      orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 1), "hosted@t236.test"),
    );
    expect(recorded.created).toBe(true);
    const order = await storeScoped(storeId).order.findUnique({ where: { id: recorded.orderId } });
    expect(order?.status).toBe("AUTHORIZED");
    expect(order?.inngestEventSentAt).toBeNull();
  });

  it("eight concurrent orders at one store all commit with consecutive numbers", async () => {
    const storeId = await makeStore("eight");
    const { variants } = await makeVariants(storeId, 20);
    const variantIds = variants.map((variant) => variant.id);
    const carts = [];
    for (let i = 0; i < 8; i++) {
      const paymentIntentId = `pi_${crypto.randomUUID()}`;
      const made = await makeCart(storeId, variantIds, 1, paymentIntentId);
      carts.push({ ...made, paymentIntentId, email: `eight-${i}@t236.test` });
    }
    const storeCtid = parseCtid(await rowCtid(storeId, "stores", storeId));
    const holder = hold(storeId, async (client) => {
      const locked = await client.query<{ ctid: string }>(
        "SELECT ctid::text AS ctid FROM stores WHERE id = $1 FOR KEY SHARE",
        [storeId],
      );
      if (locked.rowCount !== 1) throw new Error("holder did not lock the store row");
    });
    const holderPid = await holder.ready();
    const pending = carts.map((cart) =>
      recordAuthorizedOrder(
        storeId,
        orderInput(cart.cart.id, cart.paymentIntentId, orderLines(variantIds, 1), cart.email),
      ),
    );
    try {
      await poll("eight checkouts wait on the store row", async () => {
        const waiters = await waitersOfHolder(holderPid, "stores", storeCtid.page, storeCtid.tuple);
        return waiters.length === 8;
      });
      holder.release();
      const recorded = await Promise.all(pending);
      expect(recorded.every((row) => row.created)).toBe(true);
      const orders = await storeScoped(storeId).order.findMany({ include: { lines: true } });
      expect(orders.map((order) => order.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(new Set(orders.map((order) => order.id)).size).toBe(8);
      expect(await storeScoped(storeId).customer.count()).toBe(8);
      for (const order of orders) {
        expect(order.lines).toHaveLength(20);
        expect(order.totalAuthorizedCents).toBe(11_299);
        for (const line of order.lines) expect(line.unitPriceCents).toBe(500);
      }
      for (const cart of carts) {
        const stored = await storeScoped(storeId).cart.findUnique({
          where: { id: cart.cart.id },
          include: { lines: true },
        });
        expect(stored?.paymentIntentId).toBeNull();
        expect(stored?.lines).toEqual([]);
      }
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, ...pending]);
    }
  }, 40_000);

  it("a duplicate submit of one PaymentIntent records one order and one customer", async () => {
    const storeId = await makeStore("dup");
    const { variants } = await makeVariants(storeId, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variants[0]!.id], 1, paymentIntentId);
    const input = orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 1), "dup@t236.test");
    const storeCtid = parseCtid(await rowCtid(storeId, "stores", storeId));
    const holder = hold(storeId, async (client) => {
      const locked = await client.query(
        "SELECT 1 FROM stores WHERE id = $1 FOR KEY SHARE",
        [storeId],
      );
      if (locked.rowCount !== 1) throw new Error("holder missed the store");
    });
    const holderPid = await holder.ready();
    const first = recordAuthorizedOrder(storeId, input);
    const second = recordAuthorizedOrder(storeId, input);
    try {
      await poll("both submits wait on the store row", async () => {
        const waiters = await waitersOfHolder(holderPid, "stores", storeCtid.page, storeCtid.tuple);
        return waiters.length === 2;
      });
      holder.release();
      const [a, b] = await Promise.all([first, second]);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.orderId).toBe(b.orderId);
      expect(await storeScoped(storeId).order.count()).toBe(1);
      expect(await storeScoped(storeId).customer.count()).toBe(1);
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, first, second]);
    }
  }, 30_000);

  it("a replay after the order exists returns it without a new customer", async () => {
    const storeId = await makeStore("replay");
    const { variants } = await makeVariants(storeId, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variants[0]!.id], 1, paymentIntentId);
    const input = orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 1), "replay@t236.test");
    const created = await recordAuthorizedOrder(storeId, input);
    expect(created.created).toBe(true);
    expect(created.trackingToken).toBeTruthy();
    const again = await recordAuthorizedOrder(storeId, { ...input, lines: [] });
    expect(again).toEqual({ orderId: created.orderId, created: false, trackingToken: created.trackingToken });
    expect(await storeScoped(storeId).customer.count()).toBe(1);
    expect(await storeScoped(storeId).order.count()).toBe(1);
  });

  it("replay leaves refilled and second carts untouched", async () => {
    const storeId = await makeStore("refill");
    const { variants } = await makeVariants(storeId, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variants[0]!.id], 1, paymentIntentId);
    const input = orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 1), "refill@t236.test");
    const created = await recordAuthorizedOrder(storeId, input);
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId: variants[0]!.id, qty: 4, swapRule: "exact_only" },
    });
    const refilledPi = `pi_refilled_${crypto.randomUUID()}`;
    await storeScoped(storeId).cart.update({
      where: { id: cart.id },
      data: { paymentIntentId: refilledPi },
    });
    const secondPi = `pi_${crypto.randomUUID()}`;
    const second = await makeCart(storeId, [variants[0]!.id], 3, secondPi);
    const replay = await recordAuthorizedOrder(storeId, input);
    expect(replay).toEqual({ orderId: created.orderId, created: false, trackingToken: created.trackingToken });
    await expect(
      recordAuthorizedOrder(storeId, { ...input, cartId: second.cart.id }),
    ).rejects.toThrow("PaymentIntent is already recorded");
    const refilled = await storeScoped(storeId).cart.findUnique({
      where: { id: cart.id },
      include: { lines: true },
    });
    expect(refilled?.paymentIntentId).toBe(refilledPi);
    expect(refilled?.lines.map((line) => line.qty)).toEqual([4]);
    const other = await storeScoped(storeId).cart.findUnique({
      where: { id: second.cart.id },
      include: { lines: true },
    });
    expect(other?.paymentIntentId).toBe(secondPi);
    expect(other?.lines.map((line) => line.qty)).toEqual([3]);
    expect(await storeScoped(storeId).order.count()).toBe(1);
    expect(await storeScoped(storeId).customer.count()).toBe(1);
  });

  it("an item added to the cart during checkout does not deadlock and stays in the cart", async () => {
    const storeId = await makeStore("midadd");
    const { variants } = await makeVariants(storeId, 1);
    const variantId = variants[0]!.id;
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart, lines } = await makeCart(storeId, [variantId], 1, paymentIntentId);
    const line = lines[0]!;
    const holder = hold(storeId, async (client) => {
      const locked = await client.query(
        "SELECT id FROM cart_lines WHERE id = $1 FOR KEY SHARE",
        [line.id],
      );
      if (locked.rowCount !== 1) throw new Error("holder missed the cart line");
    });
    const holderPid = await holder.ready();
    const checkout = recordAuthorizedOrder(
      storeId,
      orderInput(cart.id, paymentIntentId, orderLines([variantId], 1), "midadd@t236.test"),
    );
    let adding: Promise<void> = Promise.resolve();
    try {
      let checkoutPid = 0;
      await poll("checkout waits to delete the held line", async () => {
        const waiters = await pidsWaitingOn(holderPid);
        if (waiters.length !== 1) return false;
        checkoutPid = waiters[0]!;
        return true;
      }, 20_000);
      await assertCartHeldBy(storeId, cart.id, checkoutPid);
      adding = addLine(storeId, cart.id, variantId, 2);
      await poll("addLine waits on the checkout cart lock", async () => {
        const waiters = await pidsWaitingOn(checkoutPid);
        return waiters.some((pid) => pid !== holderPid);
      }, 20_000);
      holder.release();
      const recorded = await checkout;
      await adding;
      const order = await storeScoped(storeId).order.findUnique({
        where: { id: recorded.orderId },
        include: { lines: true },
      });
      expect(order?.lines.map((row) => row.qtyOrdered)).toEqual([1]);
      const stored = await storeScoped(storeId).cart.findUnique({
        where: { id: cart.id },
        include: { lines: true },
      });
      expect(stored?.lines).toHaveLength(1);
      expect(stored?.lines[0]).toMatchObject({ variantId, qty: 2 });
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, checkout, adding]);
    }
  }, 45_000);

  it("addLine owning the cart first changes the basket, so checkout places nothing", async () => {
    const storeId = await makeStore("addfirst");
    const { variants } = await makeVariants(storeId, 1);
    const variantId = variants[0]!.id;
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart, lines } = await makeCart(storeId, [variantId], 1, paymentIntentId);
    const holder = hold(storeId, async (client) => {
      const locked = await client.query(
        "SELECT id FROM cart_lines WHERE id = $1 FOR KEY SHARE",
        [lines[0]!.id],
      );
      if (locked.rowCount !== 1) throw new Error("holder missed the cart line");
    });
    const holderPid = await holder.ready();
    const adding = addLine(storeId, cart.id, variantId, 2);
    let checkout: Promise<{ orderId: string; created: boolean }> = Promise.resolve({ orderId: "", created: false });
    try {
      let addPid = 0;
      await poll("addLine waits on the held line", async () => {
        const waiters = await pidsWaitingOn(holderPid);
        if (waiters.length !== 1) return false;
        addPid = waiters[0]!;
        return true;
      });
      await assertCartHeldBy(storeId, cart.id, addPid);
      checkout = recordAuthorizedOrder(
        storeId,
        orderInput(cart.id, paymentIntentId, orderLines([variantId], 1), "addfirst@t236.test"),
      );
      await poll("checkout waits on the cart addLine holds", async () => {
        const waiters = await pidsWaitingOn(addPid);
        return waiters.some((pid) => pid !== holderPid);
      });
      holder.release();
      await adding;
      await expect(checkout).rejects.toThrow(/Your basket changed/);
      expect(await storeScoped(storeId).order.count({ where: { sourceCartId: cart.id } })).toBe(0);
      const stored = await storeScoped(storeId).cart.findUnique({
        where: { id: cart.id },
        include: { lines: true },
      });
      expect(stored?.lines).toHaveLength(1);
      expect(stored?.lines[0]).toMatchObject({ variantId, qty: 3 });
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, adding, checkout]);
    }
  }, 30_000);

  async function raceAccept(first: "accept" | "checkout") {
    const storeId = await makeStore(`accept-${first}`);
    const { variants } = await makeVariants(storeId, 1);
    const variantId = variants[0]!.id;
    const existingPi = `pi_${crypto.randomUUID()}`;
    const { cart: existingCart } = await makeCart(storeId, [variantId], 1, existingPi);
    const existing = await recordAuthorizedOrder(
      storeId,
      orderInput(existingCart.id, existingPi, orderLines([variantId], 1), `prior-${first}@t236.test`),
    );
    const nextPi = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variantId], 1, nextPi);
    const storeCtid = parseCtid(await rowCtid(storeId, "stores", storeId));
    const holder = hold(storeId, async (client) => {
      const locked = await client.query("SELECT 1 FROM stores WHERE id = $1 FOR KEY SHARE", [storeId]);
      if (locked.rowCount !== 1) throw new Error("holder missed the store");
    });
    const holderPid = await holder.ready();
    const startAccept = () => acceptOrder(storeId, existing.orderId, 15);
    const startCheckout = () =>
      recordAuthorizedOrder(storeId, orderInput(cart.id, nextPi, orderLines([variantId], 1), `next-${first}@t236.test`));
    const acceptP = first === "accept" ? startAccept() : null;
    const checkoutP = first === "checkout" ? startCheckout() : null;
    try {
      await poll("first transaction waits on the store", async () =>
        (await waitersOfHolder(holderPid, "stores", storeCtid.page, storeCtid.tuple)).length >= 1,
      );
      const acceptRun = acceptP ?? startAccept();
      const checkoutRun = checkoutP ?? startCheckout();
      await poll("checkout and accept both wait on the store", async () =>
        (await waitersOfHolder(holderPid, "stores", storeCtid.page, storeCtid.tuple)).length >= 2,
      );
      holder.release();
      const [accepted, recorded] = await Promise.all([acceptRun, checkoutRun]);
      expect(accepted).toEqual({ ok: true });
      expect(recorded.created).toBe(true);
      expect(
        (await storeScoped(storeId).order.findUnique({ where: { id: existing.orderId } }))?.status,
      ).toBe("ACCEPTED");
      const created = await storeScoped(storeId).order.findUnique({ where: { id: recorded.orderId } });
      expect(created?.status).toBe("AUTHORIZED");
      expect(created?.prepEstimateMinutes ?? null).toBeNull();
      const acceptedRow = await storeScoped(storeId).order.findUnique({ where: { id: existing.orderId } });
      expect(acceptedRow?.prepEstimateMinutes).toBe(15);
      expect(acceptedRow?.acceptedAt).toBeTruthy();
    } finally {
      holder.release();
      await Promise.allSettled([holder.done]);
    }
  }

  it("checkout and an order transition at the same store both commit", async () => {
    await raceAccept("checkout");
  }, 30_000);

  it("acceptOrder persists ACCEPTED while checkout creates AUTHORIZED", async () => {
    await raceAccept("accept");
    await raceAccept("checkout");
  }, 40_000);

  function keptRows(variants: Array<{ id: string; label: string }>, nextPrice: number): SaveVariantInput[] {
    return variants
      .filter((variant) => variant.label !== "V2")
      .map((variant) => ({
        id: variant.id,
        label: variant.label,
        // V1 is outside the cart, so the save writes its audit row without changing the basket.
        price: variant.label === "V1" ? nextPrice : PRICE,
        weightG: 100,
        sku: null,
        barcode: null,
      }));
  }

  /**
   * Stops the first writer while it holds what it holds, starts the second until it waits on
   * the first, then lets both run. A save that took the listing without the store deadlocks
   * here: it waits on the store for its audit row while checkout holds the store and waits on
   * the listing.
   */
  async function raceSave(entry: "listing" | "variants", first: "save" | "checkout") {
    const storeId = await makeStore(`${entry}-${first}`);
    const scoped = storeScoped(storeId);
    const listing = await scoped.listing.create({
      data: {
        storeId,
        customName: `${entry} ${first}`,
        price: PRICE,
        stockMode: "counted",
        qty: 10,
        frozen: false,
        perishable: false,
      },
    });
    const created = [];
    for (const label of ["V0", "V1", "V2"]) {
      created.push(
        await scoped.listingVariant.create({
          data: { listingId: listing.id, label, price: PRICE, weightG: 100 },
        }),
      );
    }
    const v0 = created[0]!;
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [v0.id], 2, paymentIntentId);
    const input = orderInput(cart.id, paymentIntentId, orderLines([v0.id], 2), `${entry}-${first}@t236.test`);
    const payload = keptRows(created, 750);
    const removed = created.find((variant) => variant.label === "V2")!;
    const save = () =>
      entry === "listing"
        ? updateListing({ storeId, listingId: listing.id, qty: 20, variants: payload, actor })
        : updateVariants({ storeId, listingId: listing.id, variants: payload, actor });
    const checkout = () => recordAuthorizedOrder(storeId, input);
    // KEY SHARE on the removed variant stops a save after its listing lock. KEY SHARE on the
    // cart stops checkout after its store lock.
    const pause = hold(storeId, async (client) => {
      const locked = first === "save"
        ? await client.query("SELECT id FROM listing_variants WHERE id = $1 FOR KEY SHARE", [removed.id])
        : await client.query("SELECT id FROM carts WHERE id = $1 FOR KEY SHARE", [cart.id]);
      if (locked.rowCount !== 1) throw new Error("holder missed its row");
    });
    const pausePid = await pause.ready();
    let saved: unknown;
    let recorded: { created: boolean; orderId: string } | undefined;
    let firstRun: Promise<unknown> | null = null;
    let secondRun: Promise<unknown> | null = null;
    try {
      firstRun = first === "save" ? save() : checkout();
      let firstPid = 0;
      await poll(`${first} stops on the holder`, async () => {
        firstPid = (await pidsBlockedBy(pausePid))[0] ?? 0;
        return firstPid > 0;
      });
      secondRun = first === "save" ? checkout() : save();
      await poll("the second writer waits on the first", async () => (await pidsBlockedBy(firstPid)).length > 0);
      pause.release();
      const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
      saved = first === "save" ? firstResult : secondResult;
      recorded = (first === "save" ? secondResult : firstResult) as { created: boolean; orderId: string };
    } finally {
      pause.release();
      await Promise.allSettled([pause.done, firstRun, secondRun]);
    }
    expect(saved).toBeTruthy();
    expect(recorded?.created).toBe(true);
    const counted = entry === "listing";
    // A count after the reservation is the truth. A reservation after the count takes from it.
    const finalQty = !counted ? 8 : first === "save" ? 18 : 20;
    const stock = await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(stock.qty).toBe(finalQty);
    const reservations = await storeScoped(storeId).stockEvent.findMany({
      where: { listingId: listing.id, type: "reservation" },
    });
    expect(reservations.map((event) => event.delta)).toEqual([-2]);
    const listingRow = await storeScoped(storeId).listing.findUnique({
      where: { id: listing.id },
      include: { variants: true },
    });
    expect(listingRow?.variants.map((variant) => variant.label).sort()).toEqual(["V0", "V1"]);
    expect(listingRow?.variants.find((variant) => variant.label === "V1")?.price).toBe(750);
    const order = await storeScoped(storeId).order.findUnique({
      where: { id: recorded!.orderId },
      include: { lines: true },
    });
    expect(order?.lines).toHaveLength(1);
    expect(order?.lines[0]?.unitPriceCents).toBe(500);
    expect(order?.lines[0]?.qtyOrdered).toBe(2);
    expect(order?.totalAuthorizedCents).toBe(input.quote.holdCents);
  }

  it("checkout and an owner save on the same listing both commit, in either order", async () => {
    await raceSave("listing", "save");
    await raceSave("listing", "checkout");
    await raceSave("variants", "save");
    await raceSave("variants", "checkout");
  }, 90_000);

  it("a failed order write after authorization leaves the cart and its PaymentIntent intact", async () => {
    const storeId = await makeStore("badline");
    const { variants } = await makeVariants(storeId, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variants[0]!.id], 1, paymentIntentId);
    const missing = "cmmissingvariant00000001";
    await expect(
      recordAuthorizedOrder(
        storeId,
        orderInput(cart.id, paymentIntentId, orderLines([missing], 1), "badline@t236.test"),
      ),
    ).rejects.toThrow(/Your basket changed/);
    expect(await storeScoped(storeId).customer.count()).toBe(0);
    expect(await storeScoped(storeId).order.count()).toBe(0);
    expect(await storeScoped(storeId).orderLine.count()).toBe(0);
    const stored = await storeScoped(storeId).cart.findUnique({
      where: { id: cart.id },
      include: { lines: true },
    });
    expect(stored?.paymentIntentId).toBe(paymentIntentId);
    expect(stored?.lines).toHaveLength(1);
    const replay = await recordAuthorizedOrder(
      storeId,
      orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 1), "badline@t236.test"),
    );
    expect(replay.created).toBe(true);
    expect(await storeScoped(storeId).order.count()).toBe(1);
  });

  it("failure after deleting cart lines restores the whole checkout", async () => {
    const storeId = await makeStore("trap");
    const { variants } = await makeVariants(storeId, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variants[0]!.id], 1, paymentIntentId);
    if (!/^[a-z0-9]+$/i.test(cart.id)) throw new Error("unexpected cart id");
    const trap = `t236_fail_${cart.id}`;
    const owner = new Client({ connectionString: process.env.DIRECT_URL });
    await owner.connect();
    try {
      await owner.query(`
        CREATE OR REPLACE FUNCTION ${trap}() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.id = '${cart.id}'
             AND NEW.payment_intent_id IS NULL
             AND OLD.payment_intent_id IS NOT NULL THEN
            RAISE EXCEPTION 't236 forced cart reset failure';
          END IF;
          RETURN NEW;
        END;
        $fn$
      `);
      await owner.query(`DROP TRIGGER IF EXISTS ${trap} ON carts`);
      await owner.query(`
        CREATE TRIGGER ${trap}
        BEFORE UPDATE ON carts
        FOR EACH ROW
        EXECUTE FUNCTION ${trap}()
      `);
      await expect(
        recordAuthorizedOrder(
          storeId,
          orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 1), "trap@t236.test"),
        ),
      ).rejects.toThrow(/t236 forced cart reset failure/);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${trap} ON carts`).catch(() => undefined);
      await owner.query(`DROP FUNCTION IF EXISTS ${trap}()`).catch(() => undefined);
      await owner.end().catch(() => undefined);
    }
    expect(await storeScoped(storeId).customer.count()).toBe(0);
    expect(await storeScoped(storeId).order.count()).toBe(0);
    expect(await storeScoped(storeId).orderLine.count()).toBe(0);
    const stored = await storeScoped(storeId).cart.findUnique({
      where: { id: cart.id },
      include: { lines: true },
    });
    expect(stored?.paymentIntentId).toBe(paymentIntentId);
    expect(stored?.lines).toHaveLength(1);
    const replay = await recordAuthorizedOrder(
      storeId,
      orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 1), "trap@t236.test"),
    );
    expect(replay.created).toBe(true);
    const cleared = await storeScoped(storeId).cart.findUnique({
      where: { id: cart.id },
      include: { lines: true },
    });
    expect(cleared?.paymentIntentId).toBeNull();
    expect(cleared?.lines).toEqual([]);
  }, 30_000);

  it("an empty line list writes nothing", async () => {
    const storeId = await makeStore("empty");
    const { variants } = await makeVariants(storeId, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeId, [variants[0]!.id], 1, paymentIntentId);
    await expect(
      recordAuthorizedOrder(storeId, orderInput(cart.id, paymentIntentId, [], "empty@t236.test")),
    ).rejects.toThrow(/Order lines are required/);
    expect(await storeScoped(storeId).customer.count()).toBe(0);
    expect(await storeScoped(storeId).order.count()).toBe(0);
    const stored = await storeScoped(storeId).cart.findUnique({
      where: { id: cart.id },
      include: { lines: true },
    });
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.paymentIntentId).toBe(paymentIntentId);
  });

  it("missing and hidden cart fail before writes", async () => {
    const storeA = await makeStore("carta");
    const storeB = await makeStore("cartb");
    const a = await makeVariants(storeA, 1);
    const b = await makeVariants(storeB, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const hidden = await makeCart(storeA, [a.variants[0]!.id], 1, paymentIntentId);
    const beforeLines = hidden.lines.length;
    await expect(
      recordAuthorizedOrder(
        storeB,
        orderInput(hidden.cart.id, `pi_${crypto.randomUUID()}`, orderLines([b.variants[0]!.id], 1), "hidden@t236.test"),
      ),
    ).rejects.toThrow(/^Cart not found$/);
    await expect(
      recordAuthorizedOrder(
        storeB,
        orderInput("cmmissingcart000000000001", `pi_${crypto.randomUUID()}`, orderLines([b.variants[0]!.id], 1), "missing@t236.test"),
      ),
    ).rejects.toThrow(/^Cart not found$/);
    expect(await storeScoped(storeB).customer.count()).toBe(0);
    expect(await storeScoped(storeB).order.count()).toBe(0);
    const still = await storeScoped(storeA).cart.findUnique({
      where: { id: hidden.cart.id },
      include: { lines: true },
    });
    expect(still?.lines).toHaveLength(beforeLines);
    expect(still?.paymentIntentId).toBe(paymentIntentId);
  });

  it("store B cannot record an order with store A's PaymentIntent or cart", async () => {
    const storeA = await makeStore("pia");
    const storeB = await makeStore("pib");
    const a = await makeVariants(storeA, 1);
    const b = await makeVariants(storeB, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const cartA = await makeCart(storeA, [a.variants[0]!.id], 1, paymentIntentId);
    const created = await recordAuthorizedOrder(
      storeA,
      orderInput(cartA.cart.id, paymentIntentId, orderLines([a.variants[0]!.id], 1), "owner@t236.test"),
    );
    const cartB = await makeCart(storeB, [b.variants[0]!.id], 1, `pi_${crypto.randomUUID()}`);
    const foreignCart = recordAuthorizedOrder(
      storeB,
      orderInput(cartA.cart.id, `pi_${crypto.randomUUID()}`, orderLines([b.variants[0]!.id], 1), "foreign-cart@t236.test"),
    );
    await expect(foreignCart).rejects.toThrow(/^Cart not found$/);
    await expect(foreignCart).rejects.not.toThrow(created.orderId);
    const foreignPi = recordAuthorizedOrder(
      storeB,
      orderInput(cartB.cart.id, paymentIntentId, orderLines([b.variants[0]!.id], 1), "foreign-pi@t236.test"),
    );
    await expect(foreignPi).rejects.toThrow(/^PaymentIntent is already recorded$/);
    await expect(foreignPi).rejects.not.toThrow(created.orderId);
    expect(await storeScoped(storeB).order.count()).toBe(0);
    expect(await storeScoped(storeB).customer.count()).toBe(0);
    const orderA = await storeScoped(storeA).order.findUnique({ where: { id: created.orderId } });
    expect(orderA?.paymentIntentId).toBe(paymentIntentId);
    expect(orderA?.status).toBe("AUTHORIZED");
  });

  it("store B cannot read or change store A's checkout rows", async () => {
    const storeA = await makeStore("isoa");
    const storeB = await makeStore("isob");
    const { variants } = await makeVariants(storeA, 1);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const { cart } = await makeCart(storeA, [variants[0]!.id], 2, paymentIntentId);
    const created = await recordAuthorizedOrder(
      storeA,
      orderInput(cart.id, paymentIntentId, orderLines([variants[0]!.id], 2), "iso@t236.test"),
    );
    const leftoverPi = `pi_${crypto.randomUUID()}`;
    const leftover = await makeCart(storeA, [variants[0]!.id], 2, leftoverPi);
    const leftoverLineId = leftover.lines[0]!.id;
    const order = await storeScoped(storeA).order.findUniqueOrThrow({
      where: { id: created.orderId },
      include: { lines: true, customer: true },
    });
    const lineId = order.lines[0]!.id;
    const customerId = order.customerId;
    const b = storeScoped(storeB);
    expect(await b.order.findUnique({ where: { id: order.id } })).toBeNull();
    expect(await b.customer.findUnique({ where: { id: customerId } })).toBeNull();
    expect(await b.orderLine.findUnique({ where: { id: lineId } })).toBeNull();
    expect(await b.cart.findUnique({ where: { id: cart.id } })).toBeNull();
    expect(await b.cart.findUnique({ where: { id: leftover.cart.id } })).toBeNull();
    expect(await b.cartLine.findUnique({ where: { id: leftoverLineId } })).toBeNull();
    await expect(b.order.update({ where: { id: order.id }, data: { notes: "stolen" } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.customer.update({ where: { id: customerId }, data: { name: "stolen" } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.orderLine.update({ where: { id: lineId }, data: { qtyOrdered: 9 } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.cart.update({ where: { id: leftover.cart.id }, data: { paymentIntentId: "pi_stolen" } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.cartLine.update({ where: { id: leftoverLineId }, data: { qty: 9 } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.cartLine.delete({ where: { id: leftoverLineId } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.order.delete({ where: { id: order.id } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.customer.delete({ where: { id: customerId } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.orderLine.delete({ where: { id: lineId } })).rejects.toMatchObject({ code: "P2025" });
    await expect(b.cart.delete({ where: { id: cart.id } })).rejects.toMatchObject({ code: "P2025" });
    expect(await b.order.updateMany({ where: { id: order.id }, data: { notes: "stolen" } })).toEqual({ count: 0 });
    expect(await b.customer.updateMany({ where: { id: customerId }, data: { name: "stolen" } })).toEqual({ count: 0 });
    expect(await b.orderLine.updateMany({ where: { id: lineId }, data: { qtyOrdered: 9 } })).toEqual({ count: 0 });
    expect(await b.cart.updateMany({ where: { id: leftover.cart.id }, data: { source: "stolen" } })).toEqual({ count: 0 });
    expect(await b.cartLine.updateMany({ where: { id: leftoverLineId }, data: { qty: 9 } })).toEqual({ count: 0 });
    expect(await b.order.deleteMany({ where: { id: order.id } })).toEqual({ count: 0 });
    expect(await b.customer.deleteMany({ where: { id: customerId } })).toEqual({ count: 0 });
    expect(await b.orderLine.deleteMany({ where: { id: lineId } })).toEqual({ count: 0 });
    expect(await b.cart.deleteMany({ where: { id: leftover.cart.id } })).toEqual({ count: 0 });
    expect(await b.cartLine.deleteMany({ where: { id: leftoverLineId } })).toEqual({ count: 0 });
    const reread = await storeScoped(storeA).order.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true, customer: true },
    });
    expect(reread.notes).toBeNull();
    expect(reread.customer.name).toBe("Ada Buyer");
    expect(reread.lines[0]?.qtyOrdered).toBe(2);
    expect(await storeScoped(storeA).customer.count()).toBe(1);
    const keptLine = await storeScoped(storeA).cartLine.findUnique({ where: { id: leftoverLineId } });
    expect(keptLine?.qty).toBe(2);
    expect(
      (await storeScoped(storeA).cart.findUnique({ where: { id: leftover.cart.id } }))?.paymentIntentId,
    ).toBe(leftoverPi);
  });
});

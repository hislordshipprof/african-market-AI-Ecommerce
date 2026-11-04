import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { healthQueryRaw, storeScoped, storeScopedTransaction } from "../db";
import {
  createListing,
  updateListing,
  updateVariants,
  type Actor,
  type SaveVariantInput,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `v221-${Date.now().toString(36)}`;
const CANT_REMOVE = (label: string) =>
  `"${label}" is in a customer's cart or an order, so it can't be removed.`;

describe.skipIf(!hasDb)("variant save in place (lane DB, app_runtime)", () => {
  let raw: PrismaClient;
  let locks: Client;
  let storeAId = "";
  let storeBId = "";
  let userId = "";
  let actor: Actor;
  let orderNo = 1000;

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
    locks = new Client({ connectionString: process.env.DATABASE_URL });
    await locks.connect();
    const storeA = await raw.store.create({
      data: { slug: `var-save-a-${RUN}`, name: `Variant Save A ${RUN}`, themePreset: "palm-and-shea" },
    });
    const storeB = await raw.store.create({
      data: { slug: `var-save-b-${RUN}`, name: `Variant Save B ${RUN}`, themePreset: "lagoon-and-coral" },
    });
    storeAId = storeA.id;
    storeBId = storeB.id;
    const user = await raw.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `var-save-${RUN}@example.com`,
        name: "Variant Save",
        emailVerified: true,
      },
    });
    userId = user.id;
    actor = { id: user.id, email: user.email };
  }, 30_000);

  afterAll(async () => {
    if (!raw) return;
    const ids = [storeAId, storeBId].filter(Boolean);
    if (ids.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.cartLine.deleteMany({ where: { storeId: { in: ids } } }),
        raw.cart.deleteMany({ where: { storeId: { in: ids } } }),
        raw.orderLine.deleteMany({ where: { storeId: { in: ids } } }),
        raw.order.deleteMany({ where: { storeId: { in: ids } } }),
        raw.customer.deleteMany({ where: { storeId: { in: ids } } }),
        raw.auditLog.deleteMany({ where: { storeId: { in: ids } } }),
        raw.stockEvent.deleteMany({ where: { storeId: { in: ids } } }),
        raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: ids } } } }),
        raw.listing.deleteMany({ where: { storeId: { in: ids } } }),
      ]);
    }
    if (userId) await raw.user.deleteMany({ where: { id: userId } });
    if (ids.length > 0) await raw.store.deleteMany({ where: { id: { in: ids } } });
    await locks.end();
    await raw.$disconnect();
  }, 30_000);

  async function listingWith(
    storeId: string,
    name: string,
    variants: Array<{ label: string; price: number; weightG: number; sku?: string | null; barcode?: string | null }>,
    qty = 10,
  ) {
    return createListing({
      storeId,
      customName: `${name} ${RUN}`,
      price: variants[0]?.price ?? 800,
      stockMode: "counted",
      qty,
      frozen: false,
      perishable: false,
      variants,
      actor,
    });
  }

  async function readVariants(storeId: string, listingId: string) {
    const listing = await storeScoped(storeId).listing.findUnique({
      where: { id: listingId },
      include: { variants: { orderBy: { id: "asc" } } },
    });
    return listing;
  }

  async function seedCartLine(storeId: string, variantId: string, substituteVariantId?: string) {
    const scoped = storeScoped(storeId);
    const cart = await scoped.cart.create({ data: { storeId } });
    return scoped.cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1, substituteVariantId: substituteVariantId ?? null },
    });
  }

  async function seedOrderLine(
    storeId: string,
    variantId: string,
    unitPriceCents: number,
    substituteVariantId?: string,
  ) {
    const customer = await storeScoped(storeId).customer.create({
      data: { storeId, name: `Buyer ${orderNo}` },
    });
    const number = ++orderNo;
    return storeScopedTransaction(storeId, async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId,
          number,
          customerId: customer.id,
          subtotalCents: unitPriceCents,
          bufferCents: 0,
          totalAuthorizedCents: unitPriceCents,
          totalCents: unitPriceCents,
          paymentIntentId: `pi_${crypto.randomUUID()}`,
        },
      });
      return tx.orderLine.create({
        data: {
          storeId,
          orderId: order.id,
          listingVariantId: variantId,
          qtyOrdered: 1,
          unitPriceCents,
          substituteVariantId: substituteVariantId ?? null,
        },
      });
    });
  }

  async function priceAudits(storeId: string, listingId: string) {
    return storeScoped(storeId).auditLog.findMany({
      where: { entityId: listingId, action: "listing.variant_price_change" },
      orderBy: { createdAt: "asc" },
    });
  }

  async function storeLedger(storeId: string) {
    const scoped = storeScoped(storeId);
    const [audits, events] = await Promise.all([
      scoped.auditLog.findMany({ orderBy: { id: "asc" } }),
      scoped.stockEvent.findMany({ orderBy: { id: "asc" } }),
    ]);
    return { audits, events };
  }

  async function withReferenceReadCounts<T>(run: () => Promise<T>) {
    const proto = Client.prototype as unknown as {
      query: (this: Client, ...args: unknown[]) => unknown;
    };
    const original = proto.query;
    let cart = 0;
    let order = 0;
    proto.query = function (this: Client, ...args: unknown[]) {
      const first = args[0];
      const text = typeof first === "string"
        ? first
        : first && typeof first === "object" && "text" in first
          ? String((first as { text: unknown }).text)
          : "";
      const select = /^\s*select\b/i.test(text);
      if (select && /\bcart_lines\b/i.test(text)) cart += 1;
      if (select && /\border_lines\b/i.test(text)) order += 1;
      return original.apply(this, args);
    };
    try {
      const result = await run();
      return { result, cart, order };
    } finally {
      proto.query = original;
    }
  }

  function row(variant: { id: string }, price: number, weightG: number, label = "1kg"): SaveVariantInput {
    return { id: variant.id, label, price, weightG, sku: null, barcode: null };
  }

  let holderError: unknown = null;

  async function waitersOf(rootPid: number): Promise<number> {
    const res = await locks.query<{ n: number }>(
      `WITH RECURSIVE waiters AS (
         SELECT l.pid
         FROM pg_locks l
         WHERE NOT l.granted AND $1 = ANY(pg_blocking_pids(l.pid))
         UNION
         SELECT l.pid
         FROM pg_locks l
         JOIN waiters w ON w.pid = ANY(pg_blocking_pids(l.pid))
         WHERE NOT l.granted
       )
       SELECT COUNT(DISTINCT pid)::int AS n FROM waiters`,
      [rootPid],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async function poll(label: string, pred: () => Promise<boolean>, budgetMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
      if (holderError) throw holderError;
      if (await pred()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out: ${label}`);
  }

  function pgCode(err: unknown): string | undefined {
    return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : undefined;
  }

  async function waitsOn(waiterPid: number, blockerPid: number): Promise<boolean> {
    const res = await locks.query<{ ok: boolean }>(
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

  async function classifyVariantLock(
    storeId: string,
    variantId: string,
  ): Promise<{ kind: "free" } | { kind: "relation" } | { kind: "row"; blockerPid: number }> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    let probePid = 0;
    let outcome: { kind: "free" } | { kind: "relation" } | { kind: "row"; blockerPid: number } = { kind: "free" };
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      await client.query("SET LOCAL lock_timeout = '400ms'");
      const who = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      probePid = Number(who.rows[0]?.pid ?? 0);
      try {
        await client.query("LOCK TABLE listing_variants IN ACCESS SHARE MODE");
      } catch (err) {
        if (pgCode(err) === "55P03") return { kind: "relation" };
        if (pgCode(err) !== "42501") throw err;
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_user");
        await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      }
      await client.query("SAVEPOINT rowlock");
      try {
        await client.query("SELECT id FROM listing_variants WHERE id = $1 FOR UPDATE NOWAIT", [variantId]);
        await client.query("ROLLBACK TO SAVEPOINT rowlock");
        return { kind: "free" };
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT rowlock").catch(() => undefined);
        if (pgCode(err) !== "55P03") throw err;
      }
      // The lane role cannot pg_cancel_backend (42501). A waiting FOR UPDATE with
      // lock_timeout 0 stays open until the holder releases, and an ALTER TABLE
      // queued behind that probe blocks every later lock on the table. The
      // statement ends itself; the lock type is read while it is still waiting.
      await client.query("SET LOCAL lock_timeout = '800ms'");
      let settled = false;
      const rowLock = client.query("SELECT id FROM listing_variants WHERE id = $1 FOR UPDATE", [variantId])
        .then(() => { settled = true; })
        .catch((err: unknown) => {
          settled = true;
          if (pgCode(err) !== "57014" && pgCode(err) !== "55P03") throw err;
        });
      const started = Date.now();
      while (!settled && Date.now() - started < 900) {
        const pending = await locks.query<{ locktype: string }>(
          "SELECT locktype FROM pg_locks WHERE pid = $1 AND NOT granted",
          [probePid],
        );
        const types = pending.rows.map((row) => row.locktype);
        if (types.includes("relation")) {
          outcome = { kind: "relation" };
          break;
        }
        if (types.includes("transactionid")) {
          const blockers = await locks.query<{ pid: number }>(
            `SELECT h.pid
             FROM pg_locks w
             JOIN pg_locks h
               ON h.granted AND h.locktype = 'transactionid' AND h.transactionid = w.transactionid
             WHERE w.pid = $1 AND NOT w.granted AND w.locktype = 'transactionid' AND h.pid <> $1`,
            [probePid],
          );
          const blockerPid = Number(blockers.rows[0]?.pid ?? 0);
          if (blockerPid) {
            outcome = { kind: "row", blockerPid };
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await rowLock;
      return outcome;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }

  // A dedicated connection, not the app pool. Prisma's interactive transaction
  // did not keep SET LOCAL ROLE on this driver, so the holder saw no row and
  // took no tuple lock. The saves stay on the app pool and block on this one.
  function hold(storeId: string, work: (client: Client) => Promise<void>) {
    holderError = null;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pid = 0;
    let armed = false;
    const done = (async () => {
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_user");
        await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
        const who = await client.query<{ pid: number; current_user: string }>(
          "SELECT pg_backend_pid() AS pid, current_user",
        );
        pid = Number(who.rows[0]?.pid ?? 0);
        if (who.rows[0]?.current_user !== "app_user") {
          throw new Error(`holder role is ${who.rows[0]?.current_user ?? "unknown"}`);
        }
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
      throw err;
    });
    return {
      release,
      done,
      ready: async () => {
        await poll("holder armed", async () => armed);
        return pid;
      },
    };
  }

  it("runs as app_runtime", async () => {
    const rows = (await healthQueryRaw`SELECT current_user`) as Array<{ current_user: string }>;
    expect(rows[0]?.current_user).toBe("app_runtime");
  });

  it("keeps the variant id when a listing in a cart is saved with a new price and weight", async () => {
    for (const via of ["listing", "variants"] as const) {
      const created = await listingWith(storeAId, `Cart ${via}`, [{ label: "1kg", price: 800, weightG: 1000 }]);
      const variant = created.variants[0]!;
      const line = await seedCartLine(storeAId, variant.id);
      const payload = [row(variant, 950, 1200)];
      if (via === "listing") {
        await updateListing({ storeId: storeAId, listingId: created.id, variants: payload, actor });
      } else {
        await updateVariants({ storeId: storeAId, listingId: created.id, variants: payload, actor });
      }
      const found = await readVariants(storeAId, created.id);
      expect(found!.variants).toHaveLength(1);
      expect(found!.variants[0]).toMatchObject({ id: variant.id, price: 950, weightG: 1200, listingId: created.id });
      const lines = await storeScoped(storeAId).cartLine.findMany({ where: { id: line.id } });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.variantId).toBe(variant.id);
      const audits = await priceAudits(storeAId, created.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.before).toEqual({ variants: [{ label: "1kg", price: 800 }] });
      expect(audits[0]?.after).toEqual({ variants: [{ label: "1kg", price: 950 }] });
    }
  });

  it("keeps the variant id and the order line's unit price when an ordered variant is saved", async () => {
    const created = await listingWith(storeAId, "Ordered", [{ label: "1kg", price: 800, weightG: 1000 }]);
    const variant = created.variants[0]!;
    const line = await seedOrderLine(storeAId, variant.id, 800);
    await updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(variant, 950, 1200)],
      actor,
    });
    const found = await readVariants(storeAId, created.id);
    expect(found!.variants[0]?.id).toBe(variant.id);
    expect(found!.variants[0]?.price).toBe(950);
    const stored = await storeScoped(storeAId).orderLine.findUnique({ where: { id: line.id } });
    expect(stored?.unitPriceCents).toBe(800);
    expect(stored?.listingVariantId).toBe(variant.id);
    const order = await storeScoped(storeAId).order.findUnique({ where: { id: line.orderId } });
    expect(order?.paymentIntentId).toBeTruthy();
  });

  it("creates new rows, deletes unreferenced removed rows, and refuses removing referenced ones", async () => {
    const created = await listingWith(storeAId, "Add remove", [
      { label: "X", price: 800, weightG: 1000 },
      { label: "Y", price: 500, weightG: 500 },
      { label: "Z", price: 700, weightG: 700 },
    ]);
    const [x, , z] = [...created.variants].sort((a, b) => a.label.localeCompare(b.label));
    await seedCartLine(storeAId, x!.id, z!.id);
    await expect(updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(x!, 800, 1000, "X"), { label: "W", price: 100, weightG: 100, sku: null, barcode: null }],
      actor,
    })).rejects.toThrow(CANT_REMOVE("Z"));
    const refused = await readVariants(storeAId, created.id);
    expect(refused!.variants.map((v) => v.label).sort()).toEqual(["X", "Y", "Z"]);
    const sub = await storeScoped(storeAId).cartLine.findFirst({ where: { substituteVariantId: z!.id } });
    expect(sub?.substituteVariantId).toBe(z!.id);
    expect(refused!.variants.find((v) => v.label === "W")).toBeUndefined();

    await updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [
        row(x!, 800, 1000, "X"),
        row(z!, 700, 700, "Z"),
        { label: "W", price: 100, weightG: 100, sku: null, barcode: null },
      ],
      actor,
    });
    const saved = await readVariants(storeAId, created.id);
    expect(saved!.variants.map((v) => v.label).sort()).toEqual(["W", "X", "Z"]);
    expect(saved!.variants.find((v) => v.label === "X")?.id).toBe(x!.id);
    expect(saved!.variants.find((v) => v.label === "Z")?.id).toBe(z!.id);
    expect(saved!.variants.find((v) => v.label === "Y")).toBeUndefined();

    const ordered = await listingWith(storeAId, "Order sub", [
      { label: "Keep", price: 400, weightG: 400 },
      { label: "Sub", price: 400, weightG: 400 },
    ]);
    const keep = ordered.variants.find((v) => v.label === "Keep")!;
    const subVar = ordered.variants.find((v) => v.label === "Sub")!;
    await seedOrderLine(storeAId, keep.id, 400, subVar.id);
    await expect(updateListing({
      storeId: storeAId,
      listingId: ordered.id,
      variants: [row(keep, 400, 400, "Keep")],
      actor,
    })).rejects.toThrow(CANT_REMOVE("Sub"));
    const still = await storeScoped(storeAId).orderLine.findFirst({ where: { substituteVariantId: subVar.id } });
    expect(still?.substituteVariantId).toBe(subVar.id);
  });

  it("refuses removing a variant used only as a cart or order substitute and keeps the substitute", async () => {
    const created = await listingWith(storeAId, "Cart sub only", [
      { label: "Held", price: 300, weightG: 300 },
      { label: "Named", price: 300, weightG: 300 },
    ]);
    const held = created.variants.find((v) => v.label === "Held")!;
    const named = created.variants.find((v) => v.label === "Named")!;
    const line = await seedCartLine(storeAId, held.id, named.id);
    await expect(updateVariants({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(held, 300, 300, "Held")],
      actor,
    })).rejects.toThrow(CANT_REMOVE("Named"));
    const stored = await storeScoped(storeAId).cartLine.findUnique({ where: { id: line.id } });
    expect(stored?.substituteVariantId).toBe(named.id);
    expect((await readVariants(storeAId, created.id))!.variants).toHaveLength(2);
  });

  it("rejects ids from another listing, another store, unknown ids and duplicates", async () => {
    const l1 = await listingWith(storeAId, "L1", [{ label: "1kg", price: 800, weightG: 1000, sku: "S", barcode: "B" }]);
    const l2 = await listingWith(storeAId, "L2", [{ label: "1kg", price: 100, weightG: 100 }]);
    const lb = await listingWith(storeBId, "LB", [{ label: "1kg", price: 50, weightG: 50 }]);
    const before = async () => ({
      a1: await readVariants(storeAId, l1.id),
      a2: await readVariants(storeAId, l2.id),
      b: await readVariants(storeBId, lb.id),
    });
    const snap = await before();
    const cases: Array<{ id: string; message: RegExp; variants: SaveVariantInput[] }> = [
      { id: "other-listing", message: /^Variant not found$/, variants: [row(l2.variants[0]!, 1, 1)] },
      { id: "other-store", message: /^Variant not found$/, variants: [row(lb.variants[0]!, 1, 1)] },
      { id: "unknown", message: /^Variant not found$/, variants: [{ id: "missing-variant", label: "1kg", price: 1, weightG: 1, sku: null, barcode: null }] },
      {
        id: "duplicate",
        message: /^A variant appears twice in this save\.$/,
        variants: [row(l1.variants[0]!, 800, 1000), row(l1.variants[0]!, 900, 1000)],
      },
    ];
    for (const item of cases) {
      await expect(updateListing({
        storeId: storeAId,
        listingId: l1.id,
        variants: item.variants,
        actor,
      })).rejects.toThrow(item.message);
      await expect(updateVariants({
        storeId: storeAId,
        listingId: l1.id,
        variants: item.variants,
        actor,
      })).rejects.toThrow(item.message);
    }
    const after = await before();
    expect(after.a1!.variants).toEqual(snap.a1!.variants);
    expect(after.a2!.variants).toEqual(snap.a2!.variants);
    expect(after.b!.variants).toEqual(snap.b!.variants);
  });

  it("store B cannot read or change store A's listings, variants, cart lines, order lines or audit rows", async () => {
    const created = await listingWith(storeAId, "Isolated", [{ label: "1kg", price: 800, weightG: 1000 }]);
    const variant = created.variants[0]!;
    await seedCartLine(storeAId, variant.id);
    const orderLine = await seedOrderLine(storeAId, variant.id, 800);
    await updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(variant, 810, 1000)],
      actor,
    });
    expect(await storeScoped(storeAId).listing.findUnique({ where: { id: created.id } })).not.toBeNull();
    expect(await storeScoped(storeBId).listing.findUnique({ where: { id: created.id } })).toBeNull();
    expect(await storeScoped(storeAId).listingVariant.findUnique({ where: { id: variant.id } })).not.toBeNull();
    expect(await storeScoped(storeBId).listingVariant.findUnique({ where: { id: variant.id } })).toBeNull();
    expect(await storeScoped(storeAId).cartLine.findMany({ where: { variantId: variant.id } })).toHaveLength(1);
    expect(await storeScoped(storeBId).cartLine.findMany({ where: { variantId: variant.id } })).toEqual([]);
    expect(await storeScoped(storeAId).orderLine.findMany({ where: { listingVariantId: variant.id } })).toHaveLength(1);
    expect(await storeScoped(storeBId).orderLine.findMany({ where: { id: orderLine.id } })).toEqual([]);
    expect(await storeScoped(storeAId).auditLog.findMany({ where: { entityId: created.id } })).not.toEqual([]);
    expect(await storeScoped(storeBId).auditLog.findMany({ where: { entityId: created.id } })).toEqual([]);

    const bAuditsBefore = await storeScoped(storeBId).auditLog.count();
    await expect(updateListing({
      storeId: storeBId,
      listingId: created.id,
      price: 1,
      actor,
    })).rejects.toThrow(/^Listing not found$/);
    await expect(updateVariants({
      storeId: storeBId,
      listingId: created.id,
      variants: [row(variant, 1, 1)],
      actor,
    })).rejects.toThrow(/^Variant not found$|^Listing not found$/);
    expect(await storeScoped(storeBId).auditLog.count()).toBe(bAuditsBefore);
    expect((await readVariants(storeAId, created.id))!.variants[0]?.price).toBe(810);
    expect((await storeScoped(storeAId).orderLine.findUnique({ where: { id: orderLine.id } }))?.unitPriceCents).toBe(800);
  });

  it("a repeated save is a no-op and a stale save fails with Variant not found", async () => {
    const created = await listingWith(storeAId, "Retry", [
      { label: "X", price: 800, weightG: 1000 },
      { label: "Y", price: 500, weightG: 500 },
    ]);
    const x = created.variants.find((v) => v.label === "X")!;
    const y = created.variants.find((v) => v.label === "Y")!;
    const payload = [row(x, 950, 1000, "X")];
    await updateListing({ storeId: storeAId, listingId: created.id, variants: [row(x, 950, 1000, "X"), row(y, 500, 500, "Y")], actor });
    const auditsAfterFirst = await priceAudits(storeAId, created.id);
    await updateListing({ storeId: storeAId, listingId: created.id, variants: [row(x, 950, 1000, "X"), row(y, 500, 500, "Y")], actor });
    expect(await priceAudits(storeAId, created.id)).toHaveLength(auditsAfterFirst.length);
    expect((await readVariants(storeAId, created.id))!.variants.map((v) => v.id).sort()).toEqual([x.id, y.id].sort());

    await updateListing({ storeId: storeAId, listingId: created.id, variants: payload, actor });
    expect((await readVariants(storeAId, created.id))!.variants.map((v) => v.id)).toEqual([x.id]);
    await expect(updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(x, 950, 1000, "X"), row(y, 500, 500, "Y")],
      actor,
    })).rejects.toThrow(/^Variant not found$/);
    expect((await readVariants(storeAId, created.id))!.variants.map((v) => v.id)).toEqual([x.id]);
  });

  it("a save without ids keeps replace semantics and refuses referenced removals", async () => {
    const created = await listingWith(storeAId, "No ids", [{ label: "1kg", price: 800, weightG: 1000 }]);
    const variant = created.variants[0]!;
    await seedCartLine(storeAId, variant.id);
    await expect(updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [{ label: "1kg", price: 950, weightG: 1200, sku: null, barcode: null }],
      actor,
    })).rejects.toThrow(CANT_REMOVE("1kg"));
    const found = await readVariants(storeAId, created.id);
    expect(found!.variants).toHaveLength(1);
    expect(found!.variants[0]).toMatchObject({ id: variant.id, price: 800, weightG: 1000 });
  });

  it("concurrent saves of one listing serialise to one input", async () => {
    const created = await listingWith(storeAId, "Concurrent", [{ label: "1kg", price: 800, weightG: 1000 }]);
    const variant = created.variants[0]!;
    const base = row(variant, 800, 1000);
    const holder = hold(storeAId, async (client) => {
      const locked = await client.query("SELECT id FROM listings WHERE id = $1 FOR UPDATE", [created.id]);
      if (locked.rowCount !== 1) throw new Error(`holder locked ${locked.rowCount} listing rows`);
    });
    const holderPid = await holder.ready();
    const first = updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [base, { label: "W1", price: 100, weightG: 100, sku: null, barcode: null }],
      actor,
    });
    const second = updateVariants({
      storeId: storeAId,
      listingId: created.id,
      variants: [base, { label: "W2", price: 200, weightG: 200, sku: null, barcode: null }],
      actor,
    });
    try {
      await poll("both saves wait on the listing lock", async () => (await waitersOf(holderPid)) >= 2);
      holder.release();
      await Promise.all([first, second]);
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, first, second]);
    }
    const labels = (await readVariants(storeAId, created.id))!.variants.map((v) => v.label).sort();
    expect([["1kg", "W1"], ["1kg", "W2"]]).toContainEqual(labels);
    expect((await readVariants(storeAId, created.id))!.variants.find((v) => v.label === "1kg")?.id).toBe(variant.id);
  }, 20_000);

  it("a cart line added during a removal maps the foreign-key error to the can't-be-removed message", async () => {
    const created = await listingWith(storeAId, "Race cart", [
      { label: "Keep", price: 800, weightG: 1000 },
      { label: "Y", price: 500, weightG: 500 },
    ]);
    const keep = created.variants.find((v) => v.label === "Keep")!;
    const y = created.variants.find((v) => v.label === "Y")!;
    const cart = await storeScoped(storeAId).cart.create({ data: { storeId: storeAId } });
    const holder = hold(storeAId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO cart_lines (id, store_id, cart_id, variant_id, qty, swap_rule, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, 'exact_only', now(), now())`,
        [crypto.randomUUID(), storeAId, cart.id, y.id],
      );
      if (inserted.rowCount !== 1) throw new Error(`holder inserted ${inserted.rowCount} cart lines`);
    });
    await holder.ready();
    const save = updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(keep, 800, 1000, "Keep")],
      actor,
    });
    try {
      await poll("save waits for the open cart insert", async () => (await waitersOf(await holder.ready())) >= 1);
      holder.release();
      await expect(save).rejects.toThrow(CANT_REMOVE("Y"));
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, save]);
    }
    expect((await readVariants(storeAId, created.id))!.variants.map((v) => v.id).sort()).toEqual([keep.id, y.id].sort());
    const line = await storeScoped(storeAId).cartLine.findFirst({ where: { variantId: y.id } });
    expect(line).not.toBeNull();
  }, 20_000);

  it("a failing variant rolls back earlier in-place updates", async () => {
    const created = await listingWith(storeAId, "Rollback", [{ label: "X", price: 800, weightG: 1000 }]);
    const x = created.variants[0]!;
    const before = await storeLedger(storeAId);
    await expect(updateListing({
      storeId: storeAId,
      listingId: created.id,
      price: 1111,
      qty: 3,
      variants: [
        row(x, 1111, 1000, "X"),
        { label: "bad", price: 1, weightG: 1e12, sku: null, barcode: null },
      ],
      actor,
    })).rejects.toThrow(/out of range|integer|numeric|Invalid/i);
    const found = await readVariants(storeAId, created.id);
    expect(found!.price).toBe(800);
    expect(found!.qty).toBe(10);
    expect(found!.variants).toHaveLength(1);
    expect(found!.variants[0]).toMatchObject({ id: x.id, price: 800, weightG: 1000 });
    const after = await storeLedger(storeAId);
    expect(after.audits).toEqual(before.audits);
    expect(after.events).toEqual(before.events);
    expect(after.audits.filter((audit) => audit.entityId === created.id && audit.action === "listing.stock_change")).toEqual([]);
    expect(after.events.filter((event) => event.listingId === created.id).map((event) => event.type)).toEqual(["recount"]);
    expect(await priceAudits(storeAId, created.id)).toHaveLength(0);
  });

  it("saves 50 variants in place inside the default transaction timeout", async () => {
    const initial = Array.from({ length: 25 }, (_, i) => ({ label: `K${i}`, price: 100 + i, weightG: 100 + i }));
    const created = await listingWith(storeAId, "Fifty", initial);
    const payload: SaveVariantInput[] = [
      ...created.variants.map((v) => ({ id: v.id, label: v.label, price: v.price + 1, weightG: v.weightG, sku: null, barcode: null })),
      ...Array.from({ length: 25 }, (_, i) => ({ label: `N${i}`, price: 500 + i, weightG: 500 + i, sku: null, barcode: null })),
    ];
    await updateListing({ storeId: storeAId, listingId: created.id, variants: payload, actor });
    const found = await readVariants(storeAId, created.id);
    expect(found!.variants).toHaveLength(50);
    for (const variant of created.variants) {
      expect(found!.variants.find((v) => v.id === variant.id)?.price).toBe(variant.price + 1);
    }
  }, 20_000);

  it("updateVariants and updateListing share the in-place save and both take the listing lock", async () => {
    const created = await listingWith(storeAId, "Shared lock", [{ label: "1kg", price: 800, weightG: 1000 }]);
    const variant = created.variants[0]!;
    await seedCartLine(storeAId, variant.id);
    await updateVariants({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(variant, 801, 1000)],
      actor,
    });
    expect((await readVariants(storeAId, created.id))!.variants[0]?.id).toBe(variant.id);
    const missing = crypto.randomUUID();
    await expect(updateVariants({
      storeId: storeAId,
      listingId: missing,
      variants: [{ label: "1kg", price: 1, weightG: 1, sku: null, barcode: null }],
      actor,
    })).rejects.toThrow(/^Listing not found$/);
    await expect(updateListing({
      storeId: storeAId,
      listingId: missing,
      qty: 1,
      actor,
    })).rejects.toThrow(/^Listing not found$/);
  });

  it("waits for a concurrent cart substitute and refuses removal without clearing it", async () => {
    const created = await listingWith(storeAId, "Sub race cart", [
      { label: "Held", price: 300, weightG: 300 },
      { label: "Y", price: 300, weightG: 300 },
    ]);
    const held = created.variants.find((v) => v.label === "Held")!;
    const y = created.variants.find((v) => v.label === "Y")!;
    const line = await seedCartLine(storeAId, held.id);
    const holder = hold(storeAId, async (client) => {
      const updated = await client.query(
        "UPDATE cart_lines SET substitute_variant_id = $1, updated_at = now() WHERE id = $2",
        [y.id, line.id],
      );
      if (updated.rowCount !== 1) throw new Error(`holder updated ${updated.rowCount} cart lines`);
    });
    await holder.ready();
    const save = updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(held, 300, 300, "Held")],
      actor,
    });
    try {
      await poll("save waits while the substitute is uncommitted", async () => (await waitersOf(await holder.ready())) >= 1);
      holder.release();
      await expect(save).rejects.toThrow(CANT_REMOVE("Y"));
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, save]);
    }
    expect((await storeScoped(storeAId).cartLine.findUnique({ where: { id: line.id } }))?.substituteVariantId).toBe(y.id);
    expect((await readVariants(storeAId, created.id))!.variants).toHaveLength(2);
  }, 20_000);

  it("waits for a concurrent order substitute and refuses removal without clearing it", async () => {
    const created = await listingWith(storeAId, "Sub race order", [
      { label: "Held", price: 300, weightG: 300 },
      { label: "Y", price: 300, weightG: 300 },
    ]);
    const held = created.variants.find((v) => v.label === "Held")!;
    const y = created.variants.find((v) => v.label === "Y")!;
    const line = await seedOrderLine(storeAId, held.id, 300);
    const holder = hold(storeAId, async (client) => {
      const updated = await client.query(
        "UPDATE order_lines SET substitute_variant_id = $1, updated_at = now() WHERE id = $2",
        [y.id, line.id],
      );
      if (updated.rowCount !== 1) throw new Error(`holder updated ${updated.rowCount} order lines`);
    });
    await holder.ready();
    const save = updateVariants({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(held, 300, 300, "Held")],
      actor,
    });
    try {
      await poll("save waits while the order substitute is uncommitted", async () => (await waitersOf(await holder.ready())) >= 1);
      holder.release();
      await expect(save).rejects.toThrow(CANT_REMOVE("Y"));
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, save]);
    }
    expect((await storeScoped(storeAId).orderLine.findUnique({ where: { id: line.id } }))?.substituteVariantId).toBe(y.id);
    expect((await readVariants(storeAId, created.id))!.variants).toHaveLength(2);
  }, 20_000);

  async function removalLoses(kind: "direct" | "substitute") {
    const created = await listingWith(storeAId, `Win ${kind} ${crypto.randomUUID().slice(0, 8)}`, [
      { label: "X", price: 400, weightG: 400 },
      { label: "Y", price: 400, weightG: 400 },
    ]);
    const x = created.variants.find((v) => v.label === "X")!;
    const y = created.variants.find((v) => v.label === "Y")!;
    const line = kind === "substitute" ? await seedCartLine(storeAId, x.id) : null;
    await poll(
      "Y is visible and free before the save",
      async () => (await classifyVariantLock(storeAId, y.id)).kind === "free",
      20_000,
    );
    const holder = hold(storeAId, async (client) => {
      const locked = await client.query(
        "SELECT id FROM listing_variants WHERE id = $1 FOR UPDATE",
        [x.id],
      );
      if (locked.rowCount !== 1) throw new Error(`holder locked ${locked.rowCount} variants`);
    });
    const holderPid = await holder.ready();
    const save = updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(x, 400, 400, "X")],
      actor,
    });
    let inserter: Promise<unknown> = Promise.resolve();
    try {
      let savePid = 0;
      await poll("removal holds the Y row lock", async () => {
        const found = await classifyVariantLock(storeAId, y.id);
        if (found.kind !== "row" || !(await waitsOn(found.blockerPid, holderPid))) return false;
        savePid = found.blockerPid;
        return true;
      }, 10_000);
      let refPid = 0;
      inserter = storeScopedTransaction(storeAId, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        refPid = Number(rows[0]?.pid ?? 0);
        if (kind === "direct") {
          const cart = await tx.cart.create({ data: { storeId: storeAId } });
          await tx.cartLine.create({ data: { storeId: storeAId, cartId: cart.id, variantId: y.id, qty: 1 } });
        } else {
          await tx.cartLine.update({ where: { id: line!.id }, data: { substituteVariantId: y.id } });
        }
      });
      await poll("reference waits on the removal", async () => refPid > 0 && await waitsOn(refPid, savePid), 10_000);
      holder.release();
      await save;
      await expect(inserter).rejects.toMatchObject({ code: "P2003" });
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, save, inserter]);
    }
    const found = await readVariants(storeAId, created.id);
    expect(found!.variants.map((v) => v.id)).toEqual([x.id]);
    expect(await storeScoped(storeAId).cartLine.findMany({ where: { variantId: y.id } })).toEqual([]);
    if (line) {
      expect((await storeScoped(storeAId).cartLine.findUnique({ where: { id: line.id } }))?.substituteVariantId).toBeNull();
    }
  }

  it("reference creation cannot commit after removal wins the variant lock", async () => {
    await removalLoses("direct");
    await removalLoses("substitute");
  }, 90_000);

  it("reference creation waits for removal even when another session waits on the holder", async () => {
    const created = await listingWith(storeAId, `False waiter ${crypto.randomUUID().slice(0, 8)}`, [
      { label: "X", price: 400, weightG: 400 },
      { label: "Y", price: 400, weightG: 400 },
    ]);
    const x = created.variants.find((v) => v.label === "X")!;
    const y = created.variants.find((v) => v.label === "Y")!;
    await poll(
      "Y is visible and free before the foreign waiter",
      async () => (await classifyVariantLock(storeAId, y.id)).kind === "free",
      20_000,
    );
    const holder = hold(storeAId, async (client) => {
      const locked = await client.query(
        "SELECT id FROM listing_variants WHERE id = $1 FOR UPDATE",
        [x.id],
      );
      if (locked.rowCount !== 1) throw new Error(`holder locked ${locked.rowCount} variants`);
    });
    const holderPid = await holder.ready();
    const foreign = new Client({ connectionString: process.env.DATABASE_URL });
    await foreign.connect();
    let foreignPid = 0;
    const foreignDone = (async () => {
      try {
        await foreign.query("BEGIN");
        await foreign.query("SET LOCAL ROLE app_user");
        await foreign.query("SELECT set_config('app.store_id', $1, true)", [storeAId]);
        const who = await foreign.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        foreignPid = Number(who.rows[0]?.pid ?? 0);
        await foreign.query("SELECT id FROM listings WHERE id = $1 FOR KEY SHARE", [created.id]);
        await foreign.query("SET LOCAL lock_timeout = '1s'");
        await foreign.query("SELECT id FROM listing_variants WHERE id = $1 FOR UPDATE", [x.id]);
      } catch (err) {
        if (pgCode(err) !== "55P03") throw err;
      } finally {
        await foreign.query("ROLLBACK").catch(() => undefined);
        await foreign.end().catch(() => undefined);
      }
    })();
    let save: Promise<unknown> = Promise.resolve();
    let inserter: Promise<unknown> = Promise.resolve();
    try {
      await poll("foreign waiter is blocked on the holder", async () => foreignPid > 0 && await waitsOn(foreignPid, holderPid), 10_000);
      expect(await waitersOf(holderPid)).toBeGreaterThanOrEqual(1);
      expect((await classifyVariantLock(storeAId, y.id)).kind).toBe("free");
      save = updateListing({
        storeId: storeAId,
        listingId: created.id,
        variants: [row(x, 400, 400, "X")],
        actor,
      });
      let savePid = 0;
      await poll("removal holds Y even though the holder already has a waiter", async () => {
        const found = await classifyVariantLock(storeAId, y.id);
        if (found.kind !== "row" || !(await waitsOn(found.blockerPid, holderPid))) return false;
        savePid = found.blockerPid;
        return savePid !== foreignPid;
      }, 10_000);
      let refPid = 0;
      inserter = storeScopedTransaction(storeAId, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        refPid = Number(rows[0]?.pid ?? 0);
        const cart = await tx.cart.create({ data: { storeId: storeAId } });
        await tx.cartLine.create({ data: { storeId: storeAId, cartId: cart.id, variantId: y.id, qty: 1 } });
      });
      await poll("reference waits on the removal", async () => refPid > 0 && await waitsOn(refPid, savePid), 10_000);
      holder.release();
      await save;
      await expect(inserter).rejects.toMatchObject({ code: "P2003" });
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, save, inserter, foreignDone]);
    }
  }, 90_000);

  it("DDL timeout cannot satisfy the Y row-lock barrier", async () => {
    const created = await listingWith(storeAId, `DDL barrier ${crypto.randomUUID().slice(0, 8)}`, [
      { label: "X", price: 100, weightG: 100 },
      { label: "Y", price: 200, weightG: 200 },
    ]);
    const y = created.variants.find((v) => v.label === "Y")!;
    const owner = new Client({ connectionString: process.env.DIRECT_URL });
    await owner.connect();
    let held = false;
    try {
      const start = Date.now();
      while (Date.now() - start < 15_000 && !held) {
        await owner.query("BEGIN");
        try {
          await owner.query("SET LOCAL lock_timeout = '200ms'");
          await owner.query("LOCK TABLE listing_variants IN ACCESS EXCLUSIVE MODE");
          held = true;
        } catch (err) {
          await owner.query("ROLLBACK");
          if (pgCode(err) !== "55P03") throw err;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(held).toBe(true);
      const found = await classifyVariantLock(storeAId, y.id);
      expect(found.kind).toBe("relation");
    } finally {
      await owner.query("ROLLBACK").catch(() => undefined);
      await owner.end().catch(() => undefined);
    }
  }, 30_000);

  it("direct and substitute reference lose specifically with P2003", async () => {
    await removalLoses("direct");
    await removalLoses("substitute");
  }, 90_000);

  it("maps a real delete P2003 even when its direct reference is hidden by RLS", async () => {
    const created = await listingWith(storeAId, "Hidden fk", [{ label: "Only", price: 800, weightG: 1000 }]);
    const variant = created.variants[0]!;
    const cart = await storeScoped(storeBId).cart.create({ data: { storeId: storeBId } });
    const hidden = await storeScoped(storeBId).cartLine.create({
      data: { storeId: storeBId, cartId: cart.id, variantId: variant.id, qty: 1 },
    });
    expect(await storeScoped(storeAId).cartLine.findMany({ where: { variantId: variant.id } })).toEqual([]);
    expect(await storeScoped(storeBId).cartLine.findUnique({ where: { id: hidden.id } })).not.toBeNull();
    await expect(updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [{ label: "Replacement", price: 900, weightG: 900, sku: null, barcode: null }],
      actor,
    })).rejects.toThrow(CANT_REMOVE("Only"));
    expect((await readVariants(storeAId, created.id))!.variants.map((v) => v.id)).toEqual([variant.id]);
    expect((await storeScoped(storeBId).cartLine.findUnique({ where: { id: hidden.id } }))?.variantId).toBe(variant.id);
  });

  it("refuses removing a variant another store selected as a substitute", async () => {
    for (const save of [updateListing, updateVariants] as const) {
      const created = await listingWith(storeAId, `Hidden sub ${save.name}`, [
        { label: "X", price: 800, weightG: 1000 },
        { label: "Y", price: 700, weightG: 700 },
      ]);
      const x = created.variants.find((v) => v.label === "X")!;
      const y = created.variants.find((v) => v.label === "Y")!;
      await seedCartLine(storeAId, x.id);
      const bListing = await listingWith(storeBId, `B pack ${save.name}`, [
        { label: "B", price: 500, weightG: 500 },
      ]);
      const bVariant = bListing.variants[0]!;
      const cartLine = await seedCartLine(storeBId, bVariant.id, y.id);
      const orderLine = await seedOrderLine(storeBId, bVariant.id, 500, y.id);
      expect(await storeScoped(storeAId).cartLine.findMany({ where: { substituteVariantId: y.id } })).toEqual([]);
      expect(await storeScoped(storeAId).orderLine.findMany({ where: { substituteVariantId: y.id } })).toEqual([]);
      expect((await storeScoped(storeBId).cartLine.findUnique({ where: { id: cartLine.id } }))?.substituteVariantId).toBe(y.id);
      expect((await storeScoped(storeBId).orderLine.findUnique({ where: { id: orderLine.id } }))?.substituteVariantId).toBe(y.id);

      await expect(save({
        storeId: storeAId,
        listingId: created.id,
        variants: [row(x, 800, 1000, "X")],
        actor,
      })).rejects.toThrow(CANT_REMOVE("Y"));

      expect((await readVariants(storeAId, created.id))!.variants.map((v) => v.id).sort()).toEqual([x.id, y.id].sort());
      expect((await storeScoped(storeBId).cartLine.findUnique({ where: { id: cartLine.id } }))?.substituteVariantId).toBe(y.id);
      expect((await storeScoped(storeBId).orderLine.findUnique({ where: { id: orderLine.id } }))?.substituteVariantId).toBe(y.id);
    }
  });

  it("mixed id-less replay follows the documented replacement contract", async () => {
    const created = await listingWith(storeAId, "Replay", [{ label: "X", price: 800, weightG: 1000 }]);
    const x = created.variants[0]!;
    const fresh = () => [row(x, 800, 1000), { label: "W", price: 100, weightG: 100, sku: null, barcode: null }];
    await updateListing({ storeId: storeAId, listingId: created.id, variants: fresh(), actor });
    const firstNew = (await readVariants(storeAId, created.id))!.variants.find((v) => v.label === "W")!;
    await updateListing({ storeId: storeAId, listingId: created.id, variants: fresh(), actor });
    const second = await readVariants(storeAId, created.id);
    const secondNew = second!.variants.find((v) => v.label === "W")!;
    expect(secondNew.id).not.toBe(firstNew.id);
    expect(second!.variants.find((v) => v.id === firstNew.id)).toBeUndefined();
    expect(second!.variants.find((v) => v.id === x.id)).toBeTruthy();

    const referenced = await listingWith(storeAId, "Replay ref", [{ label: "X", price: 800, weightG: 1000 }]);
    const xr = referenced.variants[0]!;
    await updateListing({
      storeId: storeAId,
      listingId: referenced.id,
      variants: [row(xr, 800, 1000), { label: "W", price: 100, weightG: 100, sku: null, barcode: null }],
      actor,
    });
    const w = (await readVariants(storeAId, referenced.id))!.variants.find((v) => v.label === "W")!;
    await seedCartLine(storeAId, w.id);
    await expect(updateListing({
      storeId: storeAId,
      listingId: referenced.id,
      variants: [row(xr, 800, 1000), { label: "W", price: 100, weightG: 100, sku: null, barcode: null }],
      actor,
    })).rejects.toThrow(CANT_REMOVE("W"));
    expect((await readVariants(storeAId, referenced.id))!.variants.find((v) => v.id === w.id)?.label).toBe("W");
  });

  it("concurrent stale additions follow the documented snapshot contract across both save APIs", async () => {
    const created = await listingWith(storeAId, "Stale add", [{ label: "X", price: 800, weightG: 1000 }]);
    const x = created.variants[0]!;
    await updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(x, 800, 1000), { label: "W1", price: 100, weightG: 100, sku: null, barcode: null }],
      actor,
    });
    const w1 = (await readVariants(storeAId, created.id))!.variants.find((v) => v.label === "W1")!;
    await seedCartLine(storeAId, w1.id);
    await expect(updateVariants({
      storeId: storeAId,
      listingId: created.id,
      variants: [row(x, 800, 1000), { label: "W2", price: 200, weightG: 200, sku: null, barcode: null }],
      actor,
    })).rejects.toThrow(CANT_REMOVE("W1"));
    const labels = (await readVariants(storeAId, created.id))!.variants.map((v) => v.label).sort();
    expect(labels).toEqual(["1kg", "W1"]);
  });

  it("both services reject empty replacement while omitted variants remain intact", async () => {
    const created = await listingWith(storeAId, "Empty", [{ label: "1kg", price: 800, weightG: 1000 }]);
    const variant = created.variants[0]!;
    await expect(updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [],
      actor,
    })).rejects.toThrow(/^At least one variant is required$/);
    await expect(updateVariants({
      storeId: storeAId,
      listingId: created.id,
      variants: [],
      actor,
    })).rejects.toThrow(/^At least one variant is required$/);
    await updateListing({ storeId: storeAId, listingId: created.id, qty: 4, actor });
    const found = await readVariants(storeAId, created.id);
    expect(found!.qty).toBe(4);
    expect(found!.variants.map((v) => v.id)).toEqual([variant.id]);
  });

  it("refused removal and late write failure roll back parent fields stock events and all audits", async () => {
    const created = await listingWith(storeAId, "Parent rollback", [
      { label: "X", price: 800, weightG: 1000 },
      { label: "Z", price: 700, weightG: 700 },
    ]);
    const x = created.variants.find((v) => v.label === "X")!;
    const z = created.variants.find((v) => v.label === "Z")!;
    await seedCartLine(storeAId, z.id);
    await expect(updateListing({
      storeId: storeAId,
      listingId: created.id,
      price: 1111,
      qty: 1,
      variants: [row(x, 1111, 1000, "X")],
      actor,
    })).rejects.toThrow(CANT_REMOVE("Z"));
    const found = await readVariants(storeAId, created.id);
    expect(found).toMatchObject({ price: 800, qty: 10 });
    expect(found!.variants).toHaveLength(2);
    const events = await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: created.id } });
    expect(events.map((event) => event.type)).toEqual(["recount"]);
    expect(await storeScoped(storeAId).auditLog.count({ where: { entityId: created.id, action: { not: "listing.create" } } })).toBe(0);
  });

  it("store B cannot read A stock events or create events via a forged save", async () => {
    const created = await listingWith(storeAId, "Stock iso", [{ label: "1kg", price: 800, weightG: 1000 }], 8);
    await updateListing({ storeId: storeAId, listingId: created.id, qty: 5, actor });
    const events = await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: created.id } });
    expect(events.map((event) => event.type).sort()).toEqual(["adjust", "recount"]);
    expect(events.find((event) => event.type === "adjust")?.delta).toBe(-3);
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { listingId: created.id } })).toEqual([]);
    const before = await storeScoped(storeBId).stockEvent.count();
    await expect(updateListing({
      storeId: storeBId,
      listingId: created.id,
      qty: 1,
      variants: [{ label: "1kg", price: 1, weightG: 1, sku: null, barcode: null }],
      actor,
    })).rejects.toThrow(/^Listing not found$/);
    expect(await storeScoped(storeBId).stockEvent.count()).toBe(before);
    expect((await readVariants(storeAId, created.id))!.qty).toBe(5);
  });

  it("in-place edit preserves identity creation time sku barcode and audit semantics", async () => {
    const created = await listingWith(storeAId, "Identity", [
      { label: "1kg", price: 800, weightG: 1000, sku: "SKU-1", barcode: "123456" },
    ]);
    const variant = created.variants[0]!;
    const other = await listingWith(storeAId, "Other parent", [{ label: "x", price: 1, weightG: 1 }]);
    await updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [{
        id: variant.id,
        label: "1kg",
        price: 800,
        weightG: 1100,
        sku: "SKU-1",
        barcode: "123456",
        listingId: other.id,
      } as SaveVariantInput],
      actor,
    });
    const kept = (await readVariants(storeAId, created.id))!.variants[0]!;
    expect(kept).toMatchObject({
      id: variant.id,
      listingId: created.id,
      sku: "SKU-1",
      barcode: "123456",
      weightG: 1100,
      price: 800,
    });
    expect(kept.createdAt).toEqual(variant.createdAt);
    expect(await priceAudits(storeAId, created.id)).toHaveLength(0);

    await updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [
        { id: variant.id, label: "1kg", price: 800, weightG: 1100, sku: "SKU-1", barcode: "123456" },
        { label: "2kg", price: 1500, weightG: 2000, sku: null, barcode: null },
      ],
      actor,
    });
    const withNew = await readVariants(storeAId, created.id);
    const createdNew = withNew!.variants.find((v) => v.label === "2kg")!;
    await updateListing({
      storeId: storeAId,
      listingId: created.id,
      variants: [
        { id: variant.id, label: "1kg", price: 800, weightG: 1100, sku: "SKU-1", barcode: "123456" },
        { id: createdNew.id, label: "2kg", price: 1500, weightG: 2000, sku: null, barcode: null },
      ],
      actor,
    });
    const reopened = await readVariants(storeAId, created.id);
    expect(reopened!.variants.find((v) => v.label === "2kg")?.id).toBe(createdNew.id);
    expect(reopened!.variants.find((v) => v.id === variant.id)?.createdAt).toEqual(variant.createdAt);
  });

  it("removal checks stay batched for a mixed 50-variant save", async () => {
    const initial = Array.from({ length: 40 }, (_, i) => ({ label: `P${i}`, price: 100 + i, weightG: 100 + i }));
    const created = await listingWith(storeAId, "Batched", initial);
    const ordered = [...created.variants].sort((a, b) => a.label.localeCompare(b.label));
    const kept = ordered.slice(0, 25);
    const removed = ordered.slice(25);
    for (const variant of kept.slice(0, 5)) {
      await seedCartLine(storeAId, variant.id);
    }
    const payload: SaveVariantInput[] = [
      ...kept.map((v) => ({ id: v.id, label: v.label, price: v.price, weightG: v.weightG, sku: null, barcode: null })),
      ...Array.from({ length: 25 }, (_, i) => ({ label: `Q${i}`, price: 900 + i, weightG: 900 + i, sku: null, barcode: null })),
    ];
    const reads = await withReferenceReadCounts(() =>
      updateVariants({ storeId: storeAId, listingId: created.id, variants: payload, actor }),
    );
    expect(reads.cart).toBe(1);
    expect(reads.order).toBe(1);
    const found = await readVariants(storeAId, created.id);
    expect(found!.variants).toHaveLength(50);
    for (const variant of kept) expect(found!.variants.some((v) => v.id === variant.id)).toBe(true);
    for (const variant of removed) expect(found!.variants.some((v) => v.id === variant.id)).toBe(false);
    expect(await storeScoped(storeAId).cartLine.count({ where: { variantId: { in: kept.slice(0, 5).map((v) => v.id) } } })).toBe(5);
  }, 20_000);
});

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLine, updateLineQty } from "../../cart/service";
import { storeScoped } from "../../db";
import { waitForLockWaiters } from "../../listing/import-lock-test-helpers";
import { addToCart, type AssistantContext } from "./execute";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("assistant cart tool concurrency", () => {
  let raw: PrismaClient;
  let storeId = "";
  let cartId = "";
  let conversationId = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    storeId = (await raw.store.create({
      data: { slug: `ai-conc-${suffix}`, name: "Concurrency", themePreset: "palm-and-shea" },
    })).id;
    cartId = (await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } })).id;
    conversationId = (await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId, model: "claude-haiku-5-5", messages: [] },
    })).id;
  });

  afterAll(async () => {
    if (storeId) await storeScoped(storeId).cart.deleteMany({});
    if (storeId) await storeScoped(storeId).listing.deleteMany({});
    if (raw) {
      await raw.store.delete({ where: { id: storeId } }).catch(() => undefined);
      await raw.$disconnect();
    }
  });

  const ctx: AssistantContext = {
    get storeId() { return storeId; },
    get cartId() { return cartId; },
    get conversationId() { return conversationId; },
    actorUserId: null,
  };

  async function listing(name: string, maxPerOrder: number | null) {
    const row = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: name,
        price: 100,
        stockMode: "unlimited",
        maxPerOrder,
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: row.id, label: "Each", price: 100, weightG: 100 },
    });
    return variant.id;
  }

  async function holdCart() {
    const client = new Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    const locked = await client.query("SELECT id FROM carts WHERE id = $1 FOR UPDATE", [cartId]);
    if ((locked.rowCount ?? 0) !== 1) throw new Error("cart row not locked");
    const who = await client.query("SELECT pg_backend_pid() AS pid");
    return {
      pid: Number(who.rows[0].pid),
      release: async () => {
        await client.query("COMMIT");
        await client.end();
      },
    };
  }

  it("tool add and cart-page edit serialize without exceeding max", async () => {
    const variantId = await listing("Locked Max", 3);
    await addLine(storeId, cartId, variantId, 2, null);
    const hold = await holdCart();
    let added: Awaited<ReturnType<typeof addToCart>> | undefined;
    try {
      const adding = addToCart(ctx, { items: [{ variant_id: variantId, qty: 5 }] });
      await waitForLockWaiters(hold.pid, 1, { label: "assistant add waits on the cart" });
      await storeScoped(storeId).listingVariant.update({ where: { id: variantId }, data: { price: 250 } });
      const line = await storeScoped(storeId).cartLine.findFirst({ where: { variantId } });
      const editing = updateLineQty(storeId, cartId, line!.id, 1, null);
      await waitForLockWaiters(hold.pid, 2, { label: "cart edit waits on the cart" });
      await hold.release();
      [added] = await Promise.all([adding, editing]);
    } catch (error) {
      await hold.release();
      throw error;
    }
    expect(added).toMatchObject({
      ok: true,
      qty: 3,
      added: 1,
      unitPriceCents: 250,
      lineTotalCents: 750,
      addedTotalCents: 250,
      subtotalCents: 750,
    });
    const action = await storeScoped(storeId).aiAction.findFirst({
      where: { conversationId, tool: "add_to_cart" },
      orderBy: { createdAt: "desc" },
    });
    expect(action?.output).toMatchObject({ unitPriceCents: 250, lineTotalCents: 750, subtotalCents: 750 });
    const line = await storeScoped(storeId).cartLine.findFirst({ where: { variantId } });
    expect(line?.qty).toBeLessThanOrEqual(3);
    expect(await storeScoped(storeId).cartLine.count({ where: { variantId } })).toBe(1);
  }, 30_000);

  it("two first-adds of one variant make one line", async () => {
    const variantId = await listing("First Add", 99);
    await Promise.all([
      addToCart(ctx, { items: [{ variant_id: variantId, qty: 2 }] }),
      addToCart(ctx, { items: [{ variant_id: variantId, qty: 2 }] }),
    ]);
    const lines = await storeScoped(storeId).cartLine.findMany({ where: { variantId } });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.qty).toBe(4);
  });

  it("a price committed after add hydration is used by every returned and audited money field", async () => {
    const row = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Early Name",
        price: 100,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: row.id, label: "Each", price: 100, weightG: 100 },
    });
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } });
    const talk = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    const client = new Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
    await client.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await client.query("COMMIT").catch(() => undefined);
      await client.end().catch(() => undefined);
    };
    let adding: ReturnType<typeof addToCart> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      const locked = await client.query("SELECT id FROM listing_variants WHERE id = $1 FOR UPDATE", [variant.id]);
      if ((locked.rowCount ?? 0) !== 1) throw new Error("variant row not locked");
      const who = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      adding = addToCart({
        storeId,
        cartId: cart.id,
        conversationId: talk.id,
        actorUserId: null,
      }, { items: [{ variant_id: variant.id, qty: 2 }] });
      await waitForLockWaiters(Number(who.rows[0]?.pid), 1, {
        label: "cart line insert waits on the variant",
        timeoutMs: 3000,
        settled: [adding],
      });
      await client.query("UPDATE listing_variants SET price = $1 WHERE id = $2", [440, variant.id]);
      await client.query("UPDATE listings SET custom_name = $1 WHERE id = $2", ["Late Name", row.id]);
      await release();
      const added = await adding;
      expect(added).toMatchObject({
        ok: true,
        name: "Early Name",
        packLabel: "Each",
        unitPriceCents: 440,
        lineTotalCents: 880,
        addedTotalCents: 880,
        qty: 2,
        added: 2,
        subtotalCents: 880,
        imageUrl: null,
        items: [{
          name: "Early Name",
          unitPriceCents: 440,
          lineTotalCents: 880,
          addedTotalCents: 880,
          qty: 2,
          added: 2,
          imageUrl: null,
        }],
      });
      expect(JSON.stringify(added)).not.toContain("Late Name");
      const action = await storeScoped(storeId).aiAction.findFirst({
        where: { conversationId: talk.id, tool: "add_to_cart" },
      });
      expect(action?.output).toEqual(added);
      expect(JSON.stringify(action?.output)).not.toContain("Late Name");
    } finally {
      await release();
      await adding?.catch(() => undefined);
    }
  }, 20_000);
});

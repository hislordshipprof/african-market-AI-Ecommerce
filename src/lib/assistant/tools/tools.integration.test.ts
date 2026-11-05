import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addToCart as storefrontAddToCart, setLineQty } from "../../cart/actions";
import { addLine } from "../../cart/service";
import { storeScoped } from "../../db";
import {
  addToCart,
  checkAvailability,
  getCartSummary,
  removeFromCart,
  searchCatalog,
  setSwapRule,
  showProducts,
  updateCart,
  type AssistantContext,
} from "./execute";
import { addToCartInput, searchCatalogInput, toolInputSchemas } from "./schemas";

const { headerState, cartCookies } = vi.hoisted(() => ({
  headerState: new Headers(),
  cartCookies: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
  cookies: async () => ({
    get: (name: string) => {
      const value = cartCookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cartCookies.set(name, value);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("assistant catalog and cart tools", () => {
  let raw: PrismaClient;
  let storeA = "";
  let slugA = "";
  let storeB = "";
  let cartA = "";
  let otherCart = "";
  let conversation = "";
  let variantA = "";
  let variantB = "";
  let listingA = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    const a = await raw.store.create({
      data: {
        slug: `ai-tool-a-${suffix}`,
        name: "Tool A",
        themePreset: "palm-and-shea",
        minimumOrderCents: 2000,
      },
    });
    const b = await raw.store.create({
      data: { slug: `ai-tool-b-${suffix}`, name: "Tool B", themePreset: "lagoon-and-coral" },
    });
    storeA = a.id;
    slugA = a.slug;
    storeB = b.id;
    cartA = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    otherCart = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    conversation = (await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cartA, model: "claude-haiku-5-5", messages: [] },
    })).id;
    const listing = await makeListing(storeA, { name: "Egusi", price: 500 });
    listingA = listing.listingId;
    variantA = listing.variantId;
    variantB = (await makeListing(storeB, { name: "Foreign Rice", price: 400 })).variantId;
  });

  afterAll(async () => {
    if (storeA) await storeScoped(storeA).cart.deleteMany({});
    if (storeB) await storeScoped(storeB).cart.deleteMany({});
    if (storeA) await storeScoped(storeA).listing.deleteMany({});
    if (storeB) await storeScoped(storeB).listing.deleteMany({});
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
      await raw.$disconnect();
    }
  });

  function ctx(overrides?: Partial<AssistantContext>): AssistantContext {
    return {
      storeId: storeA,
      cartId: cartA,
      conversationId: conversation,
      actorUserId: null,
      ...overrides,
    };
  }

  async function makeListing(
    storeId: string,
    options: {
      name: string;
      price: number;
      confidence?: number;
      stockMode?: string;
      qty?: number | null;
      status?: string | null;
      maxPerOrder?: number | null;
      active?: boolean;
    },
  ) {
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: options.name,
        price: options.price,
        stockMode: options.stockMode ?? "unlimited",
        qty: options.qty ?? null,
        status: options.status ?? null,
        confidence: options.confidence ?? 1,
        maxPerOrder: options.maxPerOrder === undefined ? null : options.maxPerOrder,
        active: options.active ?? true,
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: options.price, weightG: 100 },
    });
    return { listingId: listing.id, variantId: variant.id };
  }

  async function lineCount() {
    return storeScoped(storeA).cartLine.count({ where: { cartId: cartA } });
  }

  it("tool schemas expose no store, cart or conversation field", () => {
    const banned = ["storeId", "store_id", "cartId", "cart_id", "conversationId", "conversation_id", "userId"];
    for (const schema of Object.values(toolInputSchemas)) {
      const text = JSON.stringify(schema);
      for (const key of banned) expect(text).not.toContain(key);
    }
  });

  it("add_to_cart rejects another store's variant and writes nothing", async () => {
    const before = await lineCount();
    const result = await addToCart(ctx(), { items: [{ variant_id: variantB, qty: 1 }] });
    expect(result).toMatchObject({ ok: false, code: "variant_not_found" });
    expect(await lineCount()).toBe(before);
    const action = await storeScoped(storeA).aiAction.findFirst({
      where: { conversationId: conversation, tool: "add_to_cart" },
      orderBy: { createdAt: "desc" },
    });
    expect(action?.ok).toBe(false);
  });

  it("set_swap_rule rejects another store's substitute", async () => {
    await addLine(storeA, cartA, variantA, 1, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { cartId: cartA, variantId: variantA } });
    const result = await setSwapRule(ctx(), {
      line_id: line!.id,
      rule: "named_substitute",
      substitute_variant_id: variantB,
    });
    expect(result).toMatchObject({ ok: false, code: "variant_not_found" });
    const still = await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } });
    expect(still?.swapRule).toBe("exact_only");
    await storeScoped(storeA).cartLine.delete({ where: { id: line!.id } });
  });

  it("update_cart and remove_from_cart reject a line from another cart", async () => {
    const other = await makeListing(storeA, { name: "Other Cart Item", price: 300 });
    await addLine(storeA, otherCart, other.variantId, 1, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { cartId: otherCart } });
    expect(await updateCart(ctx(), { line_id: line!.id, qty: 2 })).toMatchObject({ ok: false, code: "line_not_found" });
    expect(await removeFromCart(ctx(), { line_id: line!.id })).toMatchObject({ ok: false, code: "line_not_found" });
    expect(await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } })).not.toBeNull();
    await storeScoped(storeA).cart.delete({ where: { id: otherCart } });
    otherCart = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
  });

  it("show_products and check_availability report foreign ids as not found", async () => {
    const foreign = await storeScoped(storeB).listing.findFirst({ where: { storeId: storeB } });
    const shown = await showProducts(ctx(), { listing_ids: [foreign!.id, listingA] });
    expect(shown).toMatchObject({ ok: true, notFound: [foreign!.id] });
    const checked = await checkAvailability(ctx(), { listing_ids: [foreign!.id] });
    expect(checked.ok).toBe(false);
    expect(checked).toMatchObject({ code: "listing_not_found" });
  });

  it("confidence 0.5 adds with store_suggests and the may-be-unavailable flag", async () => {
    const item = await makeListing(storeA, { name: "Low Stock Grain", price: 250, confidence: 0.5 });
    const result = await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: true, mayBeUnavailable: true, swapRule: "store_suggests" });
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    expect(line?.swapRule).toBe("store_suggests");
    const checked = await checkAvailability(ctx(), { listing_ids: [item.listingId] });
    expect(checked).toMatchObject({ ok: true, items: [{ mayBeUnavailable: true }] });
    const shown = await showProducts(ctx(), { listing_ids: [item.listingId] });
    expect(shown).toMatchObject({ cards: [{ mayBeUnavailable: true }] });
  });

  it("confidence 0.5 with a valid backup sets named_substitute", async () => {
    const item = await makeListing(storeA, { name: "Needs Backup", price: 260, confidence: 0.5 });
    const backup = await makeListing(storeA, { name: "Backup Yam Flour", price: 270, confidence: 1 });
    const result = await addToCart(ctx(), {
      items: [{ variant_id: item.variantId, qty: 1, backup_variant_id: backup.variantId }],
    });
    expect(result).toMatchObject({
      ok: true,
      mayBeUnavailable: true,
      swapRule: "named_substitute",
      substituteVariantId: backup.variantId,
    });
  });

  it("confidence 0.6 and 0.7 add exact_only with no flag", async () => {
    const exact = await makeListing(storeA, { name: "Exact Six", price: 210, confidence: 0.6 });
    const high = await makeListing(storeA, { name: "High Seven", price: 220, confidence: 0.7 });
    const atSix = await addToCart(ctx(), { items: [{ variant_id: exact.variantId, qty: 1 }] });
    const atSeven = await addToCart(ctx(), { items: [{ variant_id: high.variantId, qty: 1 }] });
    expect(atSix).toMatchObject({ ok: true, mayBeUnavailable: false, swapRule: "exact_only" });
    expect(atSeven).toMatchObject({ ok: true, mayBeUnavailable: false, swapRule: "exact_only" });
  });

  it("hard-zero stock is flagged", async () => {
    const empty = await makeListing(storeA, {
      name: "Empty Shelf",
      price: 180,
      confidence: 1,
      stockMode: "counted",
      qty: 0,
    });
    const result = await addToCart(ctx(), { items: [{ variant_id: empty.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: true, mayBeUnavailable: true, swapRule: "store_suggests" });
    const checked = await checkAvailability(ctx(), { listing_ids: [empty.listingId] });
    expect(checked).toMatchObject({ items: [{ mayBeUnavailable: true }] });
  });

  it("lines the assistant creates are source ai and storefront lines stay manual", async () => {
    const manual = await makeListing(storeA, { name: "Manual Rice", price: 199 });
    const added = await makeListing(storeA, { name: "Assistant Rice", price: 199 });
    headerState.set("x-store-slug", slugA);
    cartCookies.clear();
    expect(await storefrontAddToCart(manual.variantId, 1)).toEqual({ ok: true });
    const cartId = cartCookies.get("cart_id");
    expect(cartId).toBeTruthy();
    const talk = await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cartId!, model: "claude-haiku-5-5", messages: [] },
    });
    const sameCart = ctx({ cartId, conversationId: talk.id });
    await addToCart(sameCart, { items: [{ variant_id: manual.variantId, qty: 1 }] });
    await addToCart(sameCart, { items: [{ variant_id: added.variantId, qty: 1 }] });
    const manualLine = await storeScoped(storeA).cartLine.findFirst({ where: { cartId, variantId: manual.variantId } });
    const aiLine = await storeScoped(storeA).cartLine.findFirst({ where: { cartId, variantId: added.variantId } });
    expect(manualLine?.source).toBe("manual");
    expect(manualLine?.qty).toBe(2);
    expect(aiLine?.source).toBe("ai");
  });

  it("writes exactly one ai_action per tool call", async () => {
    const before = await storeScoped(storeA).aiAction.count({ where: { conversationId: conversation } });
    await searchCatalog(ctx(), { query: "Egusi" });
    await getCartSummary(ctx(), {});
    const after = await storeScoped(storeA).aiAction.count({ where: { conversationId: conversation } });
    expect(after - before).toBe(2);
  });

  it("a failed action insert rolls back the cart write", async () => {
    const item = await makeListing(storeA, { name: "Rollback Grain", price: 111 });
    const before = await lineCount();
    const result = await addToCart(ctx({ conversationId: `missing-${randomUUID()}` }), {
      items: [{ variant_id: item.variantId, qty: 1 }],
    });
    expect(result).toMatchObject({ ok: false, code: "audit_failed" });
    expect(await lineCount()).toBe(before);
    expect(await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } })).toBeNull();
  });

  it("get_cart_summary reflects a change made on the cart page", async () => {
    const item = await makeListing(storeA, { name: "Page Edit", price: 400 });
    headerState.set("x-store-slug", slugA);
    cartCookies.clear();
    expect(await storefrontAddToCart(item.variantId, 1)).toEqual({ ok: true });
    const cartId = cartCookies.get("cart_id")!;
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { cartId } });
    expect(await setLineQty(line!.id, 3)).toEqual({ ok: true });
    const talk = await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId, model: "claude-haiku-5-5", messages: [] },
    });
    const summary = await getCartSummary(ctx({ cartId, conversationId: talk.id }), {});
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const rows = summary.lines as Array<{ lineId: string; qty: number; lineTotalCents: number }>;
    expect(rows).toEqual([expect.objectContaining({ lineId: line!.id, qty: 3, lineTotalCents: 1200 })]);
    expect(summary.subtotalCents).toBe(1200);
    expect(summary.minimumOrderCents).toBe(2000);
    expect(summary.minimumMet).toBe(false);
    expect(summary.missingCents).toBe(800);
    await storeScoped(storeA).cart.delete({ where: { id: cartId } });
  });

  it("adds up to max per order and reports the limit", async () => {
    const item = await makeListing(storeA, { name: "Limited Pack", price: 100, maxPerOrder: 3 });
    await addLine(storeA, cartA, item.variantId, 2, null);
    const result = await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 5 }] });
    expect(result).toMatchObject({ ok: true, qty: 3, limitedTo: 3, code: "max_per_order" });
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    expect(line?.qty).toBe(3);
  });

  it("nothing fits returns max_per_order and writes nothing", async () => {
    const item = await makeListing(storeA, { name: "Already Full", price: 100, maxPerOrder: 3 });
    await addLine(storeA, cartA, item.variantId, 3, null);
    const result = await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: false, code: "max_per_order" });
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    expect(line?.qty).toBe(3);
  });

  it("deactivated listing is unavailable", async () => {
    const item = await makeListing(storeA, { name: "Was Active", price: 150 });
    await addLine(storeA, cartA, item.variantId, 1, null);
    await storeScoped(storeA).listing.update({ where: { id: item.listingId }, data: { active: false } });
    const again = await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(again).toMatchObject({ ok: false, code: "unavailable" });
    const summary = await getCartSummary(ctx(), {});
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const rows = summary.lines as Array<{ name: string; unavailable: boolean }>;
    expect(rows.find((row) => row.name === "Was Active")?.unavailable).toBe(true);
  });

  it("repeating add_to_cart adds again and writes two actions", async () => {
    const item = await makeListing(storeA, { name: "Retry Item", price: 80 });
    const before = await storeScoped(storeA).aiAction.count({ where: { conversationId: conversation } });
    await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 1 }] });
    await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 1 }] });
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    expect(line?.qty).toBe(2);
    const after = await storeScoped(storeA).aiAction.count({ where: { conversationId: conversation } });
    expect(after - before).toBe(2);
    const summary = await getCartSummary(ctx(), {});
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const rows = summary.lines as Array<{ lineId: string; qty: number }>;
    expect(rows.find((row) => row.lineId === line!.id)?.qty).toBe(2);
  });

  it("a bad backup is ignored and the line uses store_suggests", async () => {
    const item = await makeListing(storeA, { name: "Bad Backup", price: 90, confidence: 0.4 });
    const inactive = await makeListing(storeA, { name: "Inactive Backup", price: 90, active: false });
    const foreign = await addToCart(ctx(), {
      items: [{ variant_id: item.variantId, qty: 1, backup_variant_id: variantB }],
    });
    expect(foreign).toMatchObject({ swapRule: "store_suggests" });
    await storeScoped(storeA).cartLine.deleteMany({ where: { variantId: item.variantId } });
    const same = await addToCart(ctx(), {
      items: [{ variant_id: item.variantId, qty: 1, backup_variant_id: item.variantId }],
    });
    expect(same).toMatchObject({ swapRule: "store_suggests" });
    await storeScoped(storeA).cartLine.deleteMany({ where: { variantId: item.variantId } });
    const dead = await addToCart(ctx(), {
      items: [{ variant_id: item.variantId, qty: 1, backup_variant_id: inactive.variantId }],
    });
    expect(dead).toMatchObject({ swapRule: "store_suggests" });
  });

  it("rejects an empty, oversized, or out-of-range add without writing", async () => {
    const before = await lineCount();
    const attempts = [
      { items: [] },
      { items: Array.from({ length: 21 }, () => ({ variant_id: variantA, qty: 1 })) },
      { items: [{ variant_id: variantA, qty: 0 }] },
      { items: [{ variant_id: variantA, qty: 100 }] },
    ];
    for (const input of attempts) {
      expect(() => addToCartInput.parse(input)).toThrow();
      await expect(addToCart(ctx(), input)).rejects.toThrow("Invalid tool input");
    }
    expect(await lineCount()).toBe(before);
  });

  it("a blank search returns no items and a huge query is rejected", async () => {
    const blank = await searchCatalog(ctx(), { query: "   " });
    expect(blank).toMatchObject({ ok: true, items: [] });
    expect(() => searchCatalogInput.parse({ query: "a".repeat(101) })).toThrow();
    await expect(searchCatalog(ctx(), { query: "a".repeat(101) })).rejects.toThrow("Invalid tool input");
  });

  it("show_products returns a null image when the listing has no photo", async () => {
    const item = await makeListing(storeA, { name: "Zz No Photo Grain", price: 50 });
    const shown = await showProducts(ctx(), { listing_ids: [item.listingId] });
    expect(shown).toMatchObject({ ok: true, cards: [{ imageUrl: null }] });
  });

  it("update_cart above the max leaves the line unchanged", async () => {
    const item = await makeListing(storeA, { name: "Qty Cap", price: 70, maxPerOrder: 3 });
    await addLine(storeA, cartA, item.variantId, 2, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const result = await updateCart(ctx(), { line_id: line!.id, qty: 9 });
    expect(result).toMatchObject({ ok: false, code: "max_per_order" });
    expect((await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } }))?.qty).toBe(2);
  });

  it("ignores store and cart fields on the tool input", async () => {
    const item = await makeListing(storeA, { name: "Stripped Keys", price: 60 });
    const result = await addToCart(ctx(), {
      storeId: storeB,
      cartId: otherCart,
      items: [{ variant_id: item.variantId, qty: 1 }],
    });
    expect(result.ok).toBe(true);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    expect(line?.cartId).toBe(cartA);
  });

  it("prices 199 cents times 3 as an exact line total", async () => {
    const item = await makeListing(storeA, { name: "Exact Money", price: 199 });
    await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 3 }] });
    const summary = await getCartSummary(ctx(), {});
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const rows = summary.lines as Array<{ name: string; lineTotalCents: number }>;
    expect(rows.find((row) => row.name === "Exact Money")?.lineTotalCents).toBe(597);
    const subtotal = summary.subtotalCents as number;
    expect(Number.isInteger(subtotal)).toBe(true);
  });
});

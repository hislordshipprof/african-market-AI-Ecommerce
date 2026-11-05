import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addToCart as storefrontAddToCart, setLineQty } from "../../cart/actions";
import { addLine } from "../../cart/service";
import { platformAdmin, storeScoped } from "../../db";
import {
  addToCart,
  checkAvailability,
  getCartSummary,
  offerChoices,
  removeFromCart,
  searchCatalog,
  setSwapRule,
  showProducts,
  suggestSubstitutes,
  updateCart,
  type AssistantContext,
} from "./execute";
import { addToCartInput, offerChoicesInput, searchCatalogInput, toolInputSchemas } from "./schemas";

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
  const createdMasterProductIds: string[] = [];
  const createdCategoryIds: string[] = [];

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
    for (const id of createdMasterProductIds) {
      await platformAdmin.masterProduct.delete({ where: { id } });
    }
    for (const id of createdCategoryIds) {
      await platformAdmin.category.delete({ where: { id } });
    }
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

  async function substituteActionIds() {
    const rows = await storeScoped(storeA).aiAction.findMany({
      where: { conversationId: conversation, tool: "suggest_substitutes" },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  async function expectOneNewSubstituteAction(
    before: Set<string>,
    listingId: string,
    result: { ok: boolean },
  ) {
    const rows = await storeScoped(storeA).aiAction.findMany({
      where: { conversationId: conversation, tool: "suggest_substitutes" },
    });
    const created = rows.filter((row) => !before.has(row.id));
    expect(rows).toHaveLength(before.size + 1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      ok: result.ok,
      input: { listing_id: listingId },
      output: result,
    });
    expect(await storeScoped(storeB).aiAction.findFirst({ where: { id: created[0]?.id } })).toBeNull();
  }

  async function makeCategory(label: string) {
    const suffix = randomUUID().slice(0, 8);
    const category = await platformAdmin.category.create({
      data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}`, sortOrder: 900 },
    });
    createdCategoryIds.push(category.id);
    return category.id;
  }

  async function makeCatalogListing(
    storeId: string,
    options: {
      name: string;
      price: number;
      confidence?: number;
      active?: boolean;
      categoryId: string | null;
      variantPrices?: number[];
      id?: string;
    },
  ) {
    const product = await platformAdmin.masterProduct.create({
      data: { name: `${options.name} ${randomUUID().slice(0, 8)}`, categoryId: options.categoryId },
    });
    createdMasterProductIds.push(product.id);
    const listing = await storeScoped(storeId).listing.create({
      data: {
        ...(options.id ? { id: options.id } : {}),
        storeId,
        masterProductId: product.id,
        customName: options.name,
        price: options.price,
        stockMode: "unlimited",
        confidence: options.confidence ?? 1,
        active: options.active ?? true,
        frozen: false,
        perishable: false,
      },
    });
    const prices = options.variantPrices ?? [options.price];
    let variantId = "";
    for (const price of prices) {
      const variant = await storeScoped(storeId).listingVariant.create({
        data: { listingId: listing.id, label: "Each", price, weightG: 100 },
      });
      if (!variantId) variantId = variant.id;
    }
    return { listingId: listing.id, variantId };
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

  it("update_cart with quantity zero removes the line", async () => {
    const item = await makeListing(storeA, { name: "Remove By Zero", price: 55 });
    await addLine(storeA, cartA, item.variantId, 2, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const result = await updateCart(ctx(), { line_id: line!.id, qty: 0 });
    expect(result).toMatchObject({ ok: true, removed: true, qty: 0 });
    expect(await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } })).toBeNull();
  });

  it("update_cart accepts a quantity equal to the listing max", async () => {
    const item = await makeListing(storeA, { name: "Exact Cap", price: 70, maxPerOrder: 3 });
    await addLine(storeA, cartA, item.variantId, 1, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const result = await updateCart(ctx(), { line_id: line!.id, qty: 3 });
    expect(result).toMatchObject({ ok: true, qty: 3 });
    expect((await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } }))?.qty).toBe(3);
  });

  it("update_cart allows a quantity when the listing sets no max", async () => {
    const item = await makeListing(storeA, { name: "No Cap Pack", price: 80 });
    await addLine(storeA, cartA, item.variantId, 1, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const result = await updateCart(ctx(), { line_id: line!.id, qty: 2 });
    expect(result).toMatchObject({ ok: true, qty: 2 });
  });

  it("set_swap_rule rejects an inactive substitute and leaves the line", async () => {
    const item = await makeListing(storeA, { name: "Needs Swap", price: 40 });
    const inactive = await makeListing(storeA, { name: "Dead Swap", price: 41, active: false });
    await addLine(storeA, cartA, item.variantId, 1, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const result = await setSwapRule(ctx(), {
      line_id: line!.id,
      rule: "named_substitute",
      substitute_variant_id: inactive.variantId,
    });
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    const still = await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } });
    expect(still?.swapRule).toBe("exact_only");
    expect(still?.substituteVariantId).toBeNull();
  });

  it("set_swap_rule clears the substitute when the rule is no longer named", async () => {
    const item = await makeListing(storeA, { name: "Named Then Exact", price: 42 });
    const backup = await makeListing(storeA, { name: "Named Backup", price: 43 });
    await addLine(storeA, cartA, item.variantId, 1, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const named = await setSwapRule(ctx(), {
      line_id: line!.id,
      rule: "named_substitute",
      substitute_variant_id: backup.variantId,
    });
    expect(named).toMatchObject({ ok: true, swapRule: "named_substitute", substituteVariantId: backup.variantId });
    const cleared = await setSwapRule(ctx(), { line_id: line!.id, rule: "exact_only" });
    expect(cleared).toMatchObject({ ok: true, swapRule: "exact_only" });
    const still = await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } });
    expect(still?.substituteVariantId).toBeNull();
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

  it("suggest_substitutes returns this store's ids in confidence, price, then id order", async () => {
    const categoryId = await makeCategory("subs");
    const source = await makeCatalogListing(storeA, { name: "Source Yam", price: 100, confidence: 1, categoryId });
    const premium = await makeCatalogListing(storeA, {
      name: "Premium Garri",
      price: 900,
      confidence: 1,
      categoryId,
      variantPrices: [900, 150],
    });
    const tiedLow = await makeCatalogListing(storeA, {
      name: "Tied Low",
      price: 200,
      confidence: 0.9,
      categoryId,
      id: `z-${randomUUID()}`,
    });
    const tiedHigh = await makeCatalogListing(storeA, {
      name: "Tied High",
      price: 200,
      confidence: 0.9,
      categoryId,
      id: `a-${randomUUID()}`,
    });
    const pricey = await makeCatalogListing(storeA, { name: "Pricey Twin", price: 800, confidence: 0.9, categoryId });
    const soft = await makeCatalogListing(storeA, { name: "Soft Stock", price: 50, confidence: 0.55, categoryId });
    const dropped = await makeCatalogListing(storeA, { name: "Dropped Sixth", price: 10, confidence: 0.4, categoryId });
    const quieter = await makeCatalogListing(storeA, { name: "Dropped Seventh", price: 10, confidence: 0.1, categoryId });
    const inactive = await makeCatalogListing(storeA, {
      name: "Inactive Twin",
      price: 1,
      confidence: 1,
      categoryId,
      active: false,
    });
    const foreign = await makeCatalogListing(storeB, { name: "Foreign Twin", price: 1, confidence: 1, categoryId });
    const tiedOrder = await storeScoped(storeA).listing.findMany({
      where: { id: { in: [tiedLow.listingId, tiedHigh.listingId] } },
      orderBy: { id: "asc" },
      select: { id: true, customName: true },
    });

    const beforeActions = await substituteActionIds();
    const result = await suggestSubstitutes(ctx(), { listing_id: source.listingId });
    expect(result).toEqual({
      ok: true,
      items: [
        { listingId: premium.listingId, name: "Premium Garri", priceCents: 150, mayBeUnavailable: false },
        { listingId: tiedOrder[0]?.id, name: tiedOrder[0]?.customName, priceCents: 200, mayBeUnavailable: false },
        { listingId: tiedOrder[1]?.id, name: tiedOrder[1]?.customName, priceCents: 200, mayBeUnavailable: false },
        { listingId: pricey.listingId, name: "Pricey Twin", priceCents: 800, mayBeUnavailable: false },
        { listingId: soft.listingId, name: "Soft Stock", priceCents: 50, mayBeUnavailable: true },
      ],
    });

    await expectOneNewSubstituteAction(beforeActions, source.listingId, result);
    const returnedIds = (result.ok ? result.items as Array<{ listingId: string }> : []).map((item) => item.listingId);
    for (const excluded of [source.listingId, dropped.listingId, quieter.listingId, inactive.listingId, foreign.listingId]) {
      expect(returnedIds).not.toContain(excluded);
    }
  });

  it("suggest_substitutes returns nothing when the listing has no category or no active sibling", async () => {
    const beforeBare = await substituteActionIds();
    const bare = await suggestSubstitutes(ctx(), { listing_id: listingA });
    expect(bare).toEqual({ ok: true, items: [], reason: "no_category" });
    await expectOneNewSubstituteAction(beforeBare, listingA, bare);

    const categoryId = await makeCategory("alone");
    const only = await makeCatalogListing(storeA, { name: "Only Grain", price: 300, categoryId });
    const inactive = await makeCatalogListing(storeA, {
      name: "Inactive Sibling",
      price: 100,
      confidence: 1,
      categoryId,
      active: false,
    });
    const beforeEmpty = await substituteActionIds();
    const empty = await suggestSubstitutes(ctx(), { listing_id: only.listingId });
    expect(empty).toEqual({ ok: true, items: [] });
    await expectOneNewSubstituteAction(beforeEmpty, only.listingId, empty);
    expect(JSON.stringify(empty)).not.toContain(inactive.listingId);
  });

  it("suggest_substitutes reports another store's listing as not found and records the action", async () => {
    const foreign = await storeScoped(storeB).listing.findFirstOrThrow({ where: { storeId: storeB } });
    const beforeActions = await substituteActionIds();
    const result = await suggestSubstitutes(ctx(), { listing_id: foreign.id });
    expect(result).toMatchObject({
      ok: false,
      code: "listing_not_found",
      message: "That product is not in this store.",
    });
    await expectOneNewSubstituteAction(beforeActions, foreign.id, result);
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

  it("add_to_cart output carries this store's variant, name, pack, price and photo", async () => {
    const item = await makeListing(storeA, { name: "Enriched Egusi", price: 640 });
    const result = await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 2 }] });
    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        added: 2,
        variantId: item.variantId,
        listingId: item.listingId,
        name: "Enriched Egusi",
        packLabel: "Each",
        unitPriceCents: 640,
        created: true,
      }],
    });
    const foreign = await addToCart(ctx(), { items: [{ variant_id: variantB, qty: 1 }] });
    expect(foreign).toMatchObject({ ok: false, code: "variant_not_found" });
    expect(await storeScoped(storeB).cartLine.count()).toBe(0);
  });

  it("offer_choices returns only this store's active listings and records one action in this store", async () => {
    const first = await makeListing(storeA, { name: "Choice Yam", price: 300 });
    const second = await makeListing(storeA, { name: "Choice Rice", price: 200 });
    const inactive = await makeListing(storeA, { name: "Hidden", price: 10, active: false });
    const foreign = await makeListing(storeB, { name: "Foreign Choice", price: 10 });
    const result = await offerChoices(ctx(), {
      options: [
        { listing_id: first.listingId },
        { listing_id: second.listingId },
        { listing_id: inactive.listingId },
        { listing_id: foreign.listingId },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      options: [
        { listingId: first.listingId, name: "Choice Yam", packLabel: "Each", priceCents: 300 },
        { listingId: second.listingId, name: "Choice Rice", packLabel: "Each", priceCents: 200 },
      ],
    });
    const notFound = (result as unknown as { notFound?: string[] }).notFound ?? [];
    expect(notFound).toEqual(expect.arrayContaining([inactive.listingId, foreign.listingId]));
    const actions = await storeScoped(storeA).aiAction.findMany({
      where: { conversationId: conversation, tool: "offer_choices" },
    });
    expect(actions).toHaveLength(1);
    expect(await storeScoped(storeB).aiAction.count({ where: { tool: "offer_choices" } })).toBe(0);
  });

  it("offer_choices rejects 1 and 7 options and fails with fewer than two valid", async () => {
    expect(() => offerChoicesInput.parse({ options: [{ listing_id: "only-one" }] })).toThrow();
    expect(() => offerChoicesInput.parse({
      options: Array.from({ length: 7 }, (_, index) => ({ listing_id: `id-${index}` })),
    })).toThrow();
    const only = await makeListing(storeA, { name: "Lonely", price: 50 });
    const result = await offerChoices(ctx(), {
      options: [{ listing_id: only.listingId }, { listing_id: "missing-listing" }],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "not_enough_choices",
      message: "There are not enough choices to pick from.",
    });
  });

  it("offer_choices validates listing-variant ownership and distinct deterministic choices", async () => {
    const listing = await storeScoped(storeA).listing.create({
      data: {
        storeId: storeA,
        customName: "Tied Price",
        price: 100,
        stockMode: "unlimited",
        confidence: 1,
        active: true,
        frozen: false,
        perishable: false,
      },
    });
    const expensive = await storeScoped(storeA).listingVariant.create({
      data: { listingId: listing.id, label: "Big", price: 500, weightG: 100 },
    });
    const cheapB = await storeScoped(storeA).listingVariant.create({
      data: { listingId: listing.id, label: "B", price: 100, weightG: 100 },
    });
    const cheapA = await storeScoped(storeA).listingVariant.create({
      data: { listingId: listing.id, label: "A", price: 100, weightG: 100 },
    });
    const other = await makeListing(storeA, { name: "Other Bowl", price: 80 });
    const mismatched = await offerChoices(ctx(), {
      options: [
        { listing_id: listing.id, variant_id: other.variantId },
        { listing_id: other.listingId },
      ],
    });
    expect(mismatched).toMatchObject({ ok: false, code: "not_enough_choices" });
    const omitted = await offerChoices(ctx({ conversationId: conversation }), {
      options: [
        { listing_id: listing.id },
        { listing_id: listing.id },
        { listing_id: other.listingId },
      ],
    });
    expect(omitted).toMatchObject({
      ok: true,
      options: [
        { variantId: cheapA.id < cheapB.id ? cheapA.id : cheapB.id, packLabel: cheapA.id < cheapB.id ? "A" : "B" },
        { listingId: other.listingId },
      ],
    });
    expect(JSON.stringify(omitted)).not.toContain(expensive.id);
  });
});

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
import { acceptanceForTurn } from "../shown";
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
    // A parallel platform-wide confirm-request run can alert on this file's low-confidence listing.
    if (storeA) await storeScoped(storeA).copilotAlert.deleteMany({});
    if (storeB) await storeScoped(storeB).copilotAlert.deleteMany({});
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

  function searchItems(result: unknown) {
    return (result as { items: Array<{ listingId: string; match: string; matchedTerm?: string; name: string }> }).items;
  }

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
      label?: string;
      customName?: string | null;
      master?: { name: string; imageUrl: string | null };
    },
  ) {
    let masterProductId: string | undefined;
    if (options.master) {
      const product = await platformAdmin.masterProduct.create({
        data: { name: options.master.name, imageUrl: options.master.imageUrl },
      });
      createdMasterProductIds.push(product.id);
      masterProductId = product.id;
    }
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        ...(masterProductId ? { masterProductId } : {}),
        customName: options.customName === undefined ? options.name : options.customName,
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
      data: { listingId: listing.id, label: options.label ?? "Each", price: options.price, weightG: 100 },
    });
    return { listingId: listing.id, variantId: variant.id };
  }

  async function freshCart() {
    const cart = await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } });
    const talk = await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    return { cartId: cart.id, conversationId: talk.id };
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
    expect(result).not.toHaveProperty("subtotalCents");
    expect(result).not.toHaveProperty("lineTotalCents");
    expect(await lineCount()).toBe(before);
    const foreignLines = await storeScoped(storeB).cartLine.count({ where: { variantId: variantB } });
    expect(foreignLines).toBe(0);
    const action = await storeScoped(storeA).aiAction.findFirst({
      where: { conversationId: conversation, tool: "add_to_cart" },
      orderBy: { createdAt: "desc" },
    });
    expect(action?.ok).toBe(false);
    expect(JSON.stringify(action?.output)).not.toContain("subtotalCents");
  });

  it("an accepted add naming a store B product is refused whole and writes in neither store", async () => {
    const talk = await freshCart();
    const beforeB = await storeScoped(storeB).cartLine.count({ where: { variantId: variantB } });
    const result = await addToCart(ctx({
      cartId: talk.cartId,
      conversationId: talk.conversationId,
      acceptance: {
        led: true,
        customerText: "yes",
        lastReplyText: "Egusi and Foreign Rice",
        lastReplyEmpty: false,
        lastReplyListingIds: [],
      },
    }), {
      items: [
        { variant_id: variantA, qty: 1 },
        { variant_id: variantB, qty: 1 },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "not_shown",
      message: "Nothing was added. Tell me which items you want, and I'll add them.",
    });
    expect(await storeScoped(storeA).cartLine.count({ where: { cartId: talk.cartId } })).toBe(0);
    expect(await storeScoped(storeB).cartLine.count({ where: { variantId: variantB } })).toBe(beforeB);
    const row = await storeScoped(storeA).aiAction.findFirst({
      where: { conversationId: talk.conversationId, tool: "add_to_cart", ok: false },
    });
    expect(row?.output).toMatchObject({ ok: false, code: "not_shown" });
    expect(await storeScoped(storeB).aiAction.findFirst({ where: { id: row?.id ?? "" } })).toBeNull();
    expect(await storeScoped(storeB).cartLine.findFirst({ where: { variantId: variantB } })).toBeNull();
  });

  it("add_to_cart returns the line total, the added total and the cart subtotal after the write", async () => {
    const cart = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    const decoy = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    const foreignCart = (await storeScoped(storeB).cart.create({ data: { storeId: storeB, source: "manual" } })).id;
    const talk = (await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cart, model: "claude-haiku-5-5", messages: [] },
    })).id;
    const other = await makeListing(storeA, { name: "Basket Yam", price: 250 });
    const item = await makeListing(storeA, { name: "Priced Egusi", price: 100 });
    await storeScoped(storeA).listing.update({ where: { id: item.listingId }, data: { price: 50 } });
    await storeScoped(storeA).listingVariant.update({ where: { id: item.variantId }, data: { price: 1099 } });
    await addLine(storeA, cart, other.variantId, 1, null);
    await addLine(storeA, cart, item.variantId, 1, null);
    await addLine(storeA, decoy, other.variantId, 4, null);
    await addLine(storeB, foreignCart, variantB, 3, null);
    const result = await addToCart(ctx({ cartId: cart, conversationId: talk }), {
      items: [{ variant_id: item.variantId, qty: 2 }],
    });
    expect(result).toMatchObject({
      ok: true,
      unitPriceCents: 1099,
      qty: 3,
      added: 2,
      lineTotalCents: 3297,
      addedTotalCents: 2198,
      subtotalCents: 3547,
    });
    const action = await storeScoped(storeA).aiAction.findFirst({
      where: { conversationId: talk, tool: "add_to_cart" },
    });
    expect(action?.output).toMatchObject({
      unitPriceCents: 1099,
      lineTotalCents: 3297,
      addedTotalCents: 2198,
      subtotalCents: 3547,
    });
    const doubled = await addToCart(ctx({ cartId: cart, conversationId: talk }), {
      items: [
        { variant_id: item.variantId, qty: 1 },
        { variant_id: item.variantId, qty: 2 },
        { variant_id: variantB, qty: 1 },
      ],
    });
    expect(doubled).toMatchObject({ ok: true, subtotalCents: 6844 });
    const rows = (doubled as unknown as { items: Array<Record<string, unknown>> }).items;
    expect(rows[0]).toMatchObject({ ok: true, added: 1, qty: 4, lineTotalCents: 4396, addedTotalCents: 1099 });
    expect(rows[1]).toMatchObject({ ok: true, added: 2, qty: 6, lineTotalCents: 6594, addedTotalCents: 2198 });
    expect(rows[2]).toMatchObject({ ok: false, code: "variant_not_found" });
    expect(rows[2]).not.toHaveProperty("lineTotalCents");
    expect(await storeScoped(storeA).cartLine.findFirst({ where: { cartId: decoy, variantId: other.variantId } })).toMatchObject({ qty: 4 });
    expect(await storeScoped(storeB).cartLine.findFirst({ where: { cartId: foreignCart, variantId: variantB } })).toMatchObject({ qty: 3 });
    await storeScoped(storeB).cartLine.deleteMany({ where: { cartId: foreignCart } });
    await storeScoped(storeB).cart.delete({ where: { id: foreignCart } });
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

  it("set_swap_rule keeps a backup on a may-be-unavailable line and refuses exact_only", async () => {
    const item = await makeListing(storeA, { name: "Low Stock Ofada", price: 236, confidence: 0.4 });
    await addToCart(ctx(), { items: [{ variant_id: item.variantId, qty: 1 }] });
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const result = await setSwapRule(ctx(), { line_id: line!.id, rule: "exact_only" });
    expect(result).toMatchObject({ ok: false, code: "backup_required" });
    const still = await storeScoped(storeA).cartLine.findUnique({ where: { id: line!.id } });
    expect(still?.swapRule).toBe("store_suggests");
    expect(await setSwapRule(ctx(), { line_id: line!.id, rule: "store_suggests" })).toMatchObject({ ok: true, swapRule: "store_suggests" });
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
    expect(result).not.toHaveProperty("subtotalCents");
    expect(result).not.toHaveProperty("lineTotalCents");
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
    const rows = summary.lines as Array<{ lineId: string; qty: number; lineTotalCents: number; variantId: string }>;
    expect(rows).toEqual([expect.objectContaining({
      lineId: line!.id,
      variantId: item.variantId,
      qty: 3,
      lineTotalCents: 1200,
    })]);
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
    expect(result).toMatchObject({
      ok: true,
      qty: 3,
      added: 1,
      limitedTo: 3,
      code: "max_per_order",
      unitPriceCents: 100,
      lineTotalCents: 300,
      addedTotalCents: 100,
    });
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

  it("add_to_cart takes a listing id with one variant, and refuses a many-variant, foreign or invented one", async () => {
    const single = await makeListing(storeA, { name: "One Pack Egusi", price: 310, confidence: 0.5 });
    const backup = await makeListing(storeA, { name: "One Pack Backup", price: 320 });
    const added = await addToCart(ctx(), {
      items: [{ variant_id: single.listingId, qty: 1, backup_variant_id: backup.listingId }],
    });
    expect(added).toMatchObject({ ok: true, variantId: single.variantId, swapRule: "named_substitute", substituteVariantId: backup.variantId });
    const many = await makeListing(storeA, { name: "Two Pack Rice", price: 330 });
    await storeScoped(storeA).listingVariant.create({
      data: { listingId: many.listingId, label: "10 lb", price: 600, weightG: 4536 },
    });
    const foreignListing = await storeScoped(storeB).listingVariant.findUnique({ where: { id: variantB } });
    for (const id of [many.listingId, foreignListing!.listingId, "cmwcn204c0034zg0mihbisxd10"]) {
      const refused = await addToCart(ctx(), { items: [{ variant_id: id, qty: 1 }] });
      expect(refused).toMatchObject({ ok: false, code: "variant_not_found" });
    }
    expect(await storeScoped(storeA).cartLine.count({ where: { variant: { listingId: many.listingId } } })).toBe(0);
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

  it("search marks an established synonym and show_products keeps the dearer pack", async () => {
    const suffix = randomUUID().slice(0, 8);
    const localName = `iyan${suffix}`;
    const item = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Pounded yam flour ${suffix}`, imageUrl: null },
      price: 450,
      label: "70g tin",
    });
    const masterId = (await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: item.listingId } })).masterProductId;
    await platformAdmin.productSynonym.create({ data: { productId: masterId!, term: localName } });
    await platformAdmin.productSynonym.create({ data: { productId: masterId!, term: `poundo yam ${suffix}` } });
    const dear = await storeScoped(storeA).listingVariant.create({
      data: { listingId: item.listingId, label: "400g tin", price: 1200, weightG: 400 },
    });
    const established = await searchCatalog(ctx(), { query: localName });
    expect(established).toMatchObject({
      ok: true,
      items: [{ listingId: item.listingId, variantId: item.variantId, priceCents: 450, match: "synonym", matchedTerm: localName }],
    });
    const near = await searchCatalog(ctx(), { query: `Ayoola poundo yam ${suffix}` });
    const nearItems = (near as unknown as { items: Array<{ listingId: string; match: string }> }).items;
    expect(nearItems.find((row) => row.listingId === item.listingId)?.match).toBe("near");
    const shown = await showProducts(ctx(), { listing_ids: [item.listingId] });
    expect(shown).toMatchObject({
      ok: true,
      cards: [{
        variants: expect.arrayContaining([
          { variantId: item.variantId, label: "70g tin", priceCents: 450 },
          { variantId: dear.id, label: "400g tin", priceCents: 1200 },
        ]),
      }],
    });
  });

  it("search keeps plural, script, pack, and near rows, and a name fit beats a synonym", async () => {
    const suffix = randomUUID().slice(0, 8);
    const rows: Array<{ query: string; name: string; pack?: string; label?: string; match: string; bare?: boolean }> = [
      { query: "yams", name: `White yam ${suffix}`, match: "name" },
      { query: "tomatoes", name: `Fresh tomato ${suffix}`, match: "name" },
      { query: "maggi cube", name: `Maggi Star seasoning cubes ${suffix}`, match: "name" },
      { query: "chocolat indigene", name: `chocolat indigène ${suffix}`, match: "name" },
      { query: "rice", name: `Rice ${suffix}`, pack: "bag", match: "name" },
      { query: "Gino tomato paste", name: `Gino tomato paste ${suffix}`, pack: "400 g", label: "400g tin", match: "name" },
      { query: "Gino tomato paste", name: `Gino tomato paste ${suffix}`, pack: "70g tin", label: "70g tin", match: "name" },
      { query: "drinks", name: `Zobo drink ${suffix}`, match: "name" },
      { query: "onion", name: `Red onions ${suffix}`, match: "name" },
      { query: "star", name: `Maggi cubes ${suffix}`, label: "star pack", match: "name", bare: true },
    ];
    for (const row of rows) {
      const item = await makeListing(storeA, {
        name: "ignored",
        customName: null,
        master: { name: row.name, imageUrl: null },
        price: 450,
        ...(row.label ? { label: row.label } : {}),
      });
      const found = await searchCatalog(ctx(), {
        query: row.bare ? row.query : `${row.query} ${suffix}`,
        ...(row.pack ? { pack: row.pack } : {}),
      });
      const hit = searchItems(found).find((itemRow) => itemRow.listingId === item.listingId);
      expect(hit?.match, `${row.query} ${suffix}`).toBe(row.match);
    }
    const plain = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Plain tomato paste ${suffix}`, imageUrl: null },
      price: 450,
    });
    const onion = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Tomato paste with onion ${suffix}`, imageUrl: null },
      price: 500,
    });
    const excluded = await searchCatalog(ctx(), { query: `tomato paste ${suffix}`, exclude: "onion" });
    const excludedIds = searchItems(excluded).map((row) => row.listingId);
    expect(excludedIds).toContain(plain.listingId);
    expect(excludedIds).not.toContain(onion.listingId);
    const sack = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Plain rice ${suffix}`, imageUrl: null },
      price: 450,
      label: "onion sack",
    });
    const labelOnly = await searchCatalog(ctx(), { query: `rice ${suffix}`, exclude: "onion" });
    expect(searchItems(labelOnly).map((row) => row.listingId)).toContain(sack.listingId);
    const berbere = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Berbere ${suffix}`, imageUrl: null },
      price: 450,
    });
    const berbereMaster = (await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: berbere.listingId } })).masterProductId;
    await platformAdmin.productSynonym.create({ data: { productId: berbereMaster!, term: "በርበሬ" } });
    const token = `zzqx${suffix}`;
    const named = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Basket of ${token}`, imageUrl: null },
      price: 450,
    });
    const decoy = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Unrelated seasoning ${suffix}`, imageUrl: null },
      price: 450,
    });
    const decoyMaster = (await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: decoy.listingId } })).masterProductId;
    await platformAdmin.productSynonym.create({ data: { productId: decoyMaster!, term: token } });
    for (let index = 0; index < 50; index += 1) {
      await makeListing(storeA, {
        name: "ignored",
        customName: null,
        master: { name: `${token}aaa${String(index).padStart(2, "0")}`, imageUrl: null },
        price: 450,
      });
    }
    const first = await searchCatalog(ctx(), { query: token, limit: 1 });
    expect(searchItems(first)[0]?.listingId).toBe(named.listingId);
    const amharic = await searchCatalog(ctx(), { query: "በርበሬ" });
    expect(searchItems(amharic).find((row) => row.listingId === berbere.listingId))
      .toMatchObject({ match: "synonym", matchedTerm: "በርበሬ" });
    const scotch = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Scotch bonnet ata rodo ${suffix}`, imageUrl: null },
      price: 450,
    });
    const cameroon = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Cameroon pepper ${suffix}`, imageUrl: null },
      price: 700,
    });
    const cameroonMaster = (await storeScoped(storeA).listing.findUniqueOrThrow({ where: { id: cameroon.listingId } })).masterProductId;
    await platformAdmin.productSynonym.create({ data: { productId: cameroonMaster!, term: `ata rodo ${suffix}` } });
    const both = await searchCatalog(ctx(), { query: `ata rodo ${suffix}`, limit: 1 });
    expect(both).toMatchObject({ ok: true, items: [{ listingId: scotch.listingId, match: "name" }] });
    const wide = await searchCatalog(ctx(), { query: `ata rodo ${suffix}` });
    const cameroonHit = searchItems(wide).find((row) => row.listingId === cameroon.listingId);
    expect(cameroonHit?.match).toBe("near");
    const cartB = (await storeScoped(storeB).cart.create({ data: { storeId: storeB, source: "manual" } })).id;
    const conversationB = (await storeScoped(storeB).aiConversation.create({
      data: { storeId: storeB, cartId: cartB, model: "claude-haiku-5-5", messages: [] },
    })).id;
    const otherStore = await searchCatalog(ctx({ storeId: storeB, cartId: cartB, conversationId: conversationB }), { query: `yams ${suffix}` });
    const otherItems = searchItems(otherStore);
    expect(otherItems.some((row) => row.listingId === scotch.listingId || row.name.includes(suffix))).toBe(false);
  });

  it("an explicit add of a near-only variant is refused and writes nothing", async () => {
    const suffix = randomUUID().slice(0, 8);
    const talk = await freshCart();
    const item = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Pounded yam flour ${suffix}`, imageUrl: null },
      price: 450,
    });
    const turn = `near-${suffix}`;
    const context = ctx({ ...talk, turnMessageId: turn, acceptance: {
      led: false,
      customerText: `Add 1 Ayoola ${suffix}.`,
      lastReplyText: "",
      lastReplyEmpty: true,
      lastReplyListingIds: [],
    } });
    const found = await searchCatalog(context, { query: `Ayoola poundo yam ${suffix}` });
    expect(searchItems(found).find((row) => row.listingId === item.listingId)?.match).toBe("near");
    const before = await storeScoped(storeA).cartLine.count({ where: { cartId: talk.cartId } });
    const result = await addToCart(context, { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: false, code: "not_shown" });
    expect(await storeScoped(storeA).cartLine.count({ where: { cartId: talk.cartId } })).toBe(before);
  });

  it("yes to an earlier proposal still adds a product that search labelled near", async () => {
    const suffix = randomUUID().slice(0, 8);
    const talk = await freshCart();
    const name = `Knorr filling seasoning ${suffix}`;
    const item = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name, imageUrl: null },
      price: 450,
    });
    const turn = `yes-${suffix}`;
    const context = ctx({ ...talk, turnMessageId: turn, acceptance: {
      led: true,
      customerText: "yes",
      lastReplyText: `I can add ${name}.`,
      lastReplyEmpty: false,
      lastReplyListingIds: [],
    } });
    await searchCatalog(context, { query: `Otherbrand ${suffix}` });
    const result = await addToCart(context, { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: true, qty: 1 });
  });

  it("yes adds a product the proposal's search returned even when the reply shortened its name", async () => {
    const suffix = randomUUID().slice(0, 8);
    const talk = await freshCart();
    const item = await makeListing(storeA, {
      name: `Eru / okazi / afang / fumbwa leaves ${suffix} (Gnetum), dried and shredded`,
      price: 450,
    });
    const proposalTurn = `propose-${suffix}`;
    const found = await searchCatalog(ctx({ ...talk, turnMessageId: proposalTurn }), { query: `eru ${suffix}` });
    expect(searchItems(found).some((row) => row.listingId === item.listingId)).toBe(true);
    const yes = `yes-eru-${suffix}`;
    const messages = [
      { role: "user", id: proposalTurn, parts: [{ type: "text", text: `Egusi soup ${suffix} for 4 people.` }] },
      {
        role: "assistant",
        id: `reply-${suffix}`,
        parts: [
          { type: "tool-search_catalog", state: "output-available", output: found },
          { type: "text", text: "- Eru / okazi leaves (Gnetum), dried and shredded, 1 pack\n\nWant me to add these?" },
        ],
      },
      { role: "user", id: yes, parts: [{ type: "text", text: "Yes, add those." }] },
    ];
    const result = await addToCart(ctx({
      ...talk,
      turnMessageId: yes,
      acceptance: acceptanceForTurn(messages, yes, "Yes, add those."),
    }), { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: true, qty: 1 });
  });

  it("yes after an explicit add does not add the near product that reply named", async () => {
    const suffix = randomUUID().slice(0, 8);
    const talk = await freshCart();
    const name = `Pounded yam flour ${suffix}`;
    const item = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name, imageUrl: null },
      price: 450,
    });
    const asked = `asked-${suffix}`;
    const yes = `yes-near-${suffix}`;
    await storeScoped(storeA).aiConversation.update({
      where: { id: talk.conversationId },
      data: {
        messages: [
          { role: "user", id: asked, parts: [{ type: "text", text: `Add 1 Ayoola ${suffix}.` }] },
          { role: "assistant", id: `reply-${suffix}`, parts: [{ type: "text", text: `The only result is ${name}.` }] },
          { role: "user", id: yes, parts: [{ type: "text", text: "yes" }] },
        ],
      },
    });
    await searchCatalog(ctx({ ...talk, turnMessageId: asked }), { query: `Ayoola poundo yam ${suffix}` });
    const result = await addToCart(ctx({ ...talk, turnMessageId: yes, acceptance: {
      led: true,
      customerText: "yes",
      lastReplyText: `The only result is ${name}.`,
      lastReplyEmpty: false,
      lastReplyListingIds: [],
    } }), { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: false, code: "not_shown" });
    expect(await storeScoped(storeA).cartLine.count({ where: { cartId: talk.cartId } })).toBe(0);
  });

  it("a named pick from offer_choices still adds a variant search labelled near", async () => {
    const suffix = randomUUID().slice(0, 8);
    const talk = await freshCart();
    const picked = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Cameroon pepper ${suffix}`, imageUrl: null },
      price: 700,
    });
    const other = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Scotch bonnet ${suffix}`, imageUrl: null },
      price: 450,
    });
    const turn = `pick-${suffix}`;
    const context = ctx({ ...talk, turnMessageId: turn, acceptance: {
      led: false,
      customerText: `Add Cameroon pepper ${suffix} (pack)`,
      lastReplyText: "",
      lastReplyEmpty: true,
      lastReplyListingIds: [],
    } });
    await searchCatalog(context, { query: `Ayoola ${suffix}` });
    await offerChoices(context, {
      options: [
        { listing_id: picked.listingId, variant_id: picked.variantId },
        { listing_id: other.listingId, variant_id: other.variantId },
      ],
    });
    const result = await addToCart(context, { items: [{ variant_id: picked.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: true, qty: 1 });
  });

  it("a recipe add is not refused when the ingredient search row is near", async () => {
    const suffix = randomUUID().slice(0, 8);
    const talk = await freshCart();
    const item = await makeListing(storeA, {
      name: "ignored",
      customName: null,
      master: { name: `Knorr chicken cubes ${suffix}`, imageUrl: null },
      price: 450,
    });
    const turn = `recipe-${suffix}`;
    const context = ctx({ ...talk, turnMessageId: turn, acceptance: {
      led: false,
      customerText: "I want to cook jollof rice for 4 people.",
      lastReplyText: "",
      lastReplyEmpty: true,
      lastReplyListingIds: [],
    } });
    await searchCatalog(context, { query: `seasoning ${suffix}` });
    const result = await addToCart(context, { items: [{ variant_id: item.variantId, qty: 1 }] });
    expect(result).toMatchObject({ ok: true, qty: 1 });
  });

  it("show_products returns a null image when the listing has no photo", async () => {
    const item = await makeListing(storeA, { name: "Zz No Photo Grain", price: 50 });
    const shown = await showProducts(ctx(), { listing_ids: [item.listingId] });
    expect(shown).toMatchObject({ ok: true, cards: [{ imageUrl: null }] });
  });

  it("update_cart with quantity zero removes the line", async () => {
    const item = await makeListing(storeA, { name: "Remove By Zero", price: 55 });
    const keeper = await makeListing(storeA, { name: "Keep Yam", price: 40 });
    const keeperCart = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    const keeperTalk = (await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: keeperCart, model: "claude-haiku-5-5", messages: [] },
    })).id;
    await addLine(storeA, keeperCart, item.variantId, 2, null);
    await addLine(storeA, keeperCart, keeper.variantId, 1, null);
    const gone = await storeScoped(storeA).cartLine.findFirst({ where: { cartId: keeperCart, variantId: item.variantId } });
    const result = await updateCart(ctx({ cartId: keeperCart, conversationId: keeperTalk }), { line_id: gone!.id, qty: 0 });
    expect(result).toMatchObject({ ok: true, removed: true, qty: 0, subtotalCents: 40 });
    expect(result).not.toHaveProperty("lineTotalCents");
    const kept = await storeScoped(storeA).cartLine.findFirst({ where: { cartId: keeperCart, variantId: keeper.variantId } });
    const removed = await removeFromCart(ctx({ cartId: keeperCart, conversationId: keeperTalk }), { line_id: kept!.id });
    expect(removed).toMatchObject({ ok: true, removed: true, subtotalCents: 0 });
    expect(removed).not.toHaveProperty("lineTotalCents");
  });

  it("update_cart accepts a quantity equal to the listing max", async () => {
    const item = await makeListing(storeA, { name: "Exact Cap", price: 70, maxPerOrder: 3 });
    await addLine(storeA, cartA, item.variantId, 1, null);
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { variantId: item.variantId } });
    const freshCart = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    const freshTalk = (await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: freshCart, model: "claude-haiku-5-5", messages: [] },
    })).id;
    await storeScoped(storeA).listingVariant.update({ where: { id: item.variantId }, data: { price: 80 } });
    await addLine(storeA, freshCart, item.variantId, 1, null);
    const priced = await storeScoped(storeA).cartLine.findFirst({ where: { cartId: freshCart, variantId: item.variantId } });
    const raised = await updateCart(ctx({ cartId: freshCart, conversationId: freshTalk }), { line_id: priced!.id, qty: 3 });
    expect(raised).toMatchObject({
      ok: true,
      qty: 3,
      variantId: item.variantId,
      unitPriceCents: 80,
      lineTotalCents: 240,
      subtotalCents: 240,
    });
    const result = await updateCart(ctx(), { line_id: line!.id, qty: 3 });
    expect(result).toMatchObject({
      ok: true,
      qty: 3,
      variantId: item.variantId,
      unitPriceCents: 80,
      lineTotalCents: 240,
    });
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
    const previousHost = process.env.R2_PUBLIC_URL;
    delete process.env.R2_PUBLIC_URL;
    try {
      const talk = await freshCart();
      const plain = await makeListing(storeA, { name: "Zzq Basket Only", price: 640, label: "4 kg" });
      const pictured = await makeListing(storeA, {
        name: "unused",
        customName: null,
        price: 1250,
        label: "800 g",
        master: { name: "Photo Yam Master", imageUrl: "catalog/ac1-photo.jpg" },
      });
      const beforeForeign = await storeScoped(storeB).cartLine.findMany({
        orderBy: { id: "asc" },
        select: { id: true, cartId: true, variantId: true, qty: true },
      });
      const result = await addToCart(ctx(talk), {
        items: [
          { variant_id: plain.variantId, qty: 2 },
          { variant_id: variantB, qty: 1 },
          { variant_id: pictured.variantId, qty: 3 },
        ],
      });
      expect(result).toEqual({
        ok: true,
        subtotalCents: 5030,
        items: [
          {
            ok: true,
            added: 2,
            lineId: expect.any(String),
            qty: 2,
            created: true,
            variantId: plain.variantId,
            listingId: plain.listingId,
            name: "Zzq Basket Only",
            packLabel: "4 kg",
            unitPriceCents: 640,
            lineTotalCents: 1280,
            addedTotalCents: 1280,
            imageUrl: null,
            swapRule: "exact_only",
            mayBeUnavailable: false,
          },
          { ok: false, code: "variant_not_found", message: "That item is not in this store." },
          {
            ok: true,
            added: 3,
            lineId: expect.any(String),
            qty: 3,
            created: true,
            variantId: pictured.variantId,
            listingId: pictured.listingId,
            name: "Photo Yam Master",
            packLabel: "800 g",
            unitPriceCents: 1250,
            lineTotalCents: 3750,
            addedTotalCents: 3750,
            imageUrl: "/api/catalog-image/catalog/ac1-photo.jpg",
            swapRule: "exact_only",
            mayBeUnavailable: false,
          },
        ],
      });
      const body = JSON.stringify(result);
      expect(body).not.toContain(variantB);
      expect(body).not.toContain("Foreign Rice");
      const lines = await storeScoped(storeA).cartLine.findMany({
        where: { cartId: talk.cartId },
        select: { variantId: true, qty: true, storeId: true },
      });
      expect(lines).toHaveLength(2);
      expect(lines).toEqual(expect.arrayContaining([
        { variantId: plain.variantId, qty: 2, storeId: storeA },
        { variantId: pictured.variantId, qty: 3, storeId: storeA },
      ]));
      expect(lines.map((line) => line.variantId)).not.toContain(variantB);
      const afterForeign = await storeScoped(storeB).cartLine.findMany({
        orderBy: { id: "asc" },
        select: { id: true, cartId: true, variantId: true, qty: true },
      });
      expect(afterForeign).toEqual(beforeForeign);
      const actions = await storeScoped(storeA).aiAction.findMany({
        where: { conversationId: talk.conversationId, tool: "add_to_cart" },
      });
      expect(actions).toHaveLength(1);
      expect(actions[0]?.output).toEqual(result);
      expect(JSON.stringify(actions[0]?.output)).not.toContain(variantB);
      expect(JSON.stringify(actions[0]?.output)).not.toContain("Foreign Rice");
      expect(await storeScoped(storeB).aiAction.findFirst({ where: { id: actions[0]?.id } })).toBeNull();
    } finally {
      if (previousHost === undefined) delete process.env.R2_PUBLIC_URL;
      else process.env.R2_PUBLIC_URL = previousHost;
    }
  });

  it("add_to_cart preserves image precedence with and without the public host", async () => {
    const saved = {
      R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: process.env.R2_BUCKET,
    };
    const restore = () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    try {
      delete process.env.R2_PUBLIC_URL;
      const unmapped = await freshCart();
      const bare = await makeListing(storeA, { name: "Zzq Unmapped Basket", price: 100 });
      const bareResult = await addToCart(ctx(unmapped), { items: [{ variant_id: bare.variantId, qty: 1 }] });
      expect(bareResult).toMatchObject({ items: [{ name: "Zzq Unmapped Basket", imageUrl: null }] });

      const cutoutCart = await freshCart();
      const yam = await makeListing(storeA, { name: "Yam", price: 200 });
      const yamResult = await addToCart(ctx(cutoutCart), { items: [{ variant_id: yam.variantId, qty: 1 }] });
      expect(yamResult).toMatchObject({
        items: [{ name: "Yam", imageUrl: "/images/products/yam-white-puna.webp" }],
      });

      const masterCart = await freshCart();
      const masterOnly = await makeListing(storeA, {
        name: "unused",
        customName: null,
        price: 300,
        master: { name: "Zzq Master Only", imageUrl: "catalog/master-only.jpg" },
      });
      const masterResult = await addToCart(ctx(masterCart), { items: [{ variant_id: masterOnly.variantId, qty: 1 }] });
      expect(masterResult).toMatchObject({
        items: [{ name: "Zzq Master Only", imageUrl: "/api/catalog-image/catalog/master-only.jpg" }],
      });

      process.env.R2_PUBLIC_URL = "https://images.example.test";
      const customCart = await freshCart();
      const customOver = await makeListing(storeA, {
        name: "Yam",
        price: 400,
        master: { name: "Master Yam Hidden", imageUrl: "https://cdn.example.test/catalog/legacy-photo.png" },
      });
      const customResult = await addToCart(ctx(customCart), { items: [{ variant_id: customOver.variantId, qty: 1 }] });
      expect(customResult).toMatchObject({
        items: [{ name: "Yam", imageUrl: "https://images.example.test/catalog/legacy-photo.png" }],
      });
      expect(JSON.stringify(customResult)).not.toContain("cdn.example.test");
      expect(JSON.stringify(customResult)).not.toContain("Master Yam Hidden");

      delete process.env.R2_PUBLIC_URL;
      const rejectedCart = await freshCart();
      const rejected = await makeListing(storeA, {
        name: "Yam",
        price: 500,
        master: { name: "Rejected Photo", imageUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a.jpg" },
      });
      const rejectedResult = await addToCart(ctx(rejectedCart), { items: [{ variant_id: rejected.variantId, qty: 1 }] });
      expect(rejectedResult).toMatchObject({
        items: [{ name: "Yam", imageUrl: "/images/products/yam-white-puna.webp" }],
      });
      expect(JSON.stringify(rejectedResult)).not.toContain("wikimedia.org");

      const absentCart = await freshCart();
      const absent = await makeListing(storeA, {
        name: "unused",
        customName: null,
        price: 600,
        master: { name: "Zzq No Photo", imageUrl: null },
      });
      const absentResult = await addToCart(ctx(absentCart), { items: [{ variant_id: absent.variantId, qty: 1 }] });
      expect(absentResult).toMatchObject({ items: [{ name: "Zzq No Photo", imageUrl: null }] });

      (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
      process.env.VERCEL = "1";
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.R2_BUCKET;
      delete process.env.R2_PUBLIC_URL;
      const hostedCart = await freshCart();
      const hosted = await makeListing(storeA, {
        name: "unused",
        customName: null,
        price: 700,
        master: { name: "Zzq Hosted Photo", imageUrl: "catalog/hosted-photo.webp" },
      });
      const hostedResult = await addToCart(ctx(hostedCart), { items: [{ variant_id: hosted.variantId, qty: 1 }] });
      expect(hostedResult).toMatchObject({
        items: [{ name: "Zzq Hosted Photo", imageUrl: "/api/catalog-image/catalog/hosted-photo.webp" }],
      });
    } finally {
      restore();
    }
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

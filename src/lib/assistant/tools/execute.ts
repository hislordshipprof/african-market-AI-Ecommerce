import type { Prisma } from "@prisma/client";
import {
  backupSwap,
  decideLineQty,
  decideNamedSubstitute,
  substituteIdForSwap,
} from "../../cart/limits";
import {
  applyAddLine,
  cartLineSubtotalCents,
  checkMinimumOrder,
  runCartMutation,
  type CartWriteTx,
  type SwapRuleValue,
} from "../../cart/service";
import { storeScoped } from "../../db";
import { listingImage } from "../../storefront/images";
import { searchListings } from "../../storefront/service";
import { stockBadge } from "../../storefront/stock-badge";
import { mayBeUnavailable, type StockFacts } from "./availability";
import {
  addToCartInput,
  cartSummaryInput,
  checkAvailabilityInput,
  parseToolInput,
  removeFromCartInput,
  searchCatalogInput,
  offerChoicesInput,
  setSwapRuleInput,
  showProductsInput,
  suggestSubstitutesInput,
  updateCartInput,
} from "./schemas";

export interface AssistantContext {
  storeId: string;
  cartId: string;
  conversationId: string;
  actorUserId: string | null;
  turnMessageId?: string;
  toolCallId?: string;
}

type ToolFailure = { ok: false; code: string; message: string; [key: string]: unknown };
type ToolSuccess = { ok: true; [key: string]: unknown };
export type ToolResult = ToolSuccess | ToolFailure;

const MESSAGES: Record<string, string> = {
  variant_not_found: "That item is not in this store.",
  line_not_found: "That cart line is not in this cart.",
  listing_not_found: "That product is not in this store.",
  unavailable: "That product is unavailable.",
  max_per_order: "That is the most of this item the store allows.",
  audit_failed: "Could not record this action.",
  not_enough_choices: "There are not enough choices to pick from.",
};

function fail(code: string): ToolFailure {
  return { ok: false, code, message: MESSAGES[code] ?? "That did not work." };
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function auditedInput(ctx: AssistantContext, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...input,
    ...(ctx.turnMessageId ? { _turn: ctx.turnMessageId } : {}),
    ...(ctx.toolCallId ? { _call: ctx.toolCallId } : {}),
  };
}

async function recordRead(
  ctx: AssistantContext,
  tool: string,
  input: unknown,
  output: ToolResult,
): Promise<ToolResult> {
  try {
    await storeScoped(ctx.storeId).aiAction.create({
      data: {
        storeId: ctx.storeId,
        conversationId: ctx.conversationId,
        tool,
        input: asJson(auditedInput(ctx, input)),
        output: asJson(output),
        ok: output.ok,
      },
    });
  } catch {
    return fail("audit_failed");
  }
  return output;
}

async function recordWrite<T extends ToolResult>(
  ctx: AssistantContext,
  tool: string,
  input: unknown,
  write: (tx: CartWriteTx) => Promise<T>,
): Promise<ToolResult> {
  try {
    return await runCartMutation(ctx.storeId, ctx.cartId, ctx.actorUserId, async (tx) => {
      const output = await write(tx);
      await tx.aiAction.create({
        data: {
          storeId: ctx.storeId,
          conversationId: ctx.conversationId,
          tool,
          input: asJson(auditedInput(ctx, input)),
          output: asJson(output),
          ok: output.ok,
        },
      });
      return output;
    });
  } catch {
    return fail("audit_failed");
  }
}

function factsOf(listing: StockFacts): StockFacts {
  return {
    confidence: listing.confidence,
    stockMode: listing.stockMode,
    qty: listing.qty,
    status: listing.status,
  };
}

export async function searchCatalog(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(searchCatalogInput, input);
  const query = parsed.query.trim();
  if (!query) return recordRead(ctx, "search_catalog", parsed, { ok: true, items: [] });
  const found = await searchListings(ctx.storeId, query);
  const items = found.slice(0, parsed.limit).map((item) => ({
    listingId: item.id,
    name: item.name,
    ...(item.altName ? { altName: item.altName } : {}),
    variantId: item.variantId ?? null,
    packLabel: item.packLabel ?? "Each",
    priceCents: item.price,
    imageUrl: item.imageUrl ?? null,
    mayBeUnavailable: item.badge !== "in-stock",
  }));
  return recordRead(ctx, "search_catalog", parsed, { ok: true, items });
}

export async function showProducts(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(showProductsInput, input);
  const scoped = storeScoped(ctx.storeId);
  const listings = await scoped.listing.findMany({
    where: { id: { in: parsed.listing_ids } },
    include: {
      masterProduct: true,
      variants: { orderBy: [{ price: "asc" }, { id: "asc" }] },
    },
  });
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  const cards = [];
  const notFound: string[] = [];
  for (const id of parsed.listing_ids) {
    const listing = byId.get(id);
    if (!listing) {
      notFound.push(id);
      continue;
    }
    const photo = listingImage({
      customName: listing.customName,
      masterProduct: listing.masterProduct
        ? { name: listing.masterProduct.name, imageUrl: listing.masterProduct.imageUrl }
        : null,
    });
    cards.push({
      listingId: listing.id,
      name: listing.customName || listing.masterProduct?.name || "Unnamed",
      imageUrl: photo ?? null,
      variants: listing.variants.map((variant) => ({
        variantId: variant.id,
        label: variant.label,
        priceCents: variant.price,
      })),
      badge: stockBadge(factsOf(listing)),
      mayBeUnavailable: mayBeUnavailable(listing),
    });
  }
  return recordRead(ctx, "show_products", parsed, { ok: true, cards, notFound });
}

export async function checkAvailability(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(checkAvailabilityInput, input);
  const listings = await storeScoped(ctx.storeId).listing.findMany({
    where: { id: { in: parsed.listing_ids } },
    include: { variants: { orderBy: [{ price: "asc" }, { id: "asc" }] } },
  });
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  const items = parsed.listing_ids.map((id) => {
    const listing = byId.get(id);
    if (!listing) return { listingId: id, ...fail("listing_not_found") };
    if (!listing.active) return { listingId: id, ...fail("unavailable") };
    const cheapest = listing.variants[0];
    return {
      listingId: id,
      ok: true as const,
      active: true,
      badge: stockBadge(factsOf(listing)),
      mayBeUnavailable: mayBeUnavailable(listing),
      priceCents: cheapest?.price ?? listing.price,
    };
  });
  const firstFailure = items.find((item) => item.ok === false);
  if (firstFailure) {
    return recordRead(ctx, "check_availability", parsed, {
      ok: false,
      code: firstFailure.code,
      message: firstFailure.message,
      items,
    });
  }
  return recordRead(ctx, "check_availability", parsed, { ok: true, items });
}

export async function suggestSubstitutes(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(suggestSubstitutesInput, input);
  const scoped = storeScoped(ctx.storeId);
  const listing = await scoped.listing.findUnique({
    where: { id: parsed.listing_id },
    include: { masterProduct: true },
  });
  if (!listing) return recordRead(ctx, "suggest_substitutes", parsed, fail("listing_not_found"));
  const categoryId = listing.masterProduct?.categoryId;
  if (!categoryId) {
    return recordRead(ctx, "suggest_substitutes", parsed, { ok: true, items: [], reason: "no_category" });
  }
  const candidates = await scoped.listing.findMany({
    where: { active: true, id: { not: listing.id }, masterProduct: { categoryId } },
    include: { masterProduct: true, variants: { orderBy: [{ price: "asc" }, { id: "asc" }] } },
    orderBy: [{ confidence: "desc" }, { price: "asc" }, { id: "asc" }],
    take: 5,
  });
  const items = candidates.map((candidate) => ({
    listingId: candidate.id,
    name: candidate.customName || candidate.masterProduct?.name || "Unnamed",
    priceCents: candidate.variants[0]?.price ?? candidate.price,
    mayBeUnavailable: mayBeUnavailable(candidate),
  }));
  return recordRead(ctx, "suggest_substitutes", parsed, { ok: true, items });
}

async function chooseBackup(
  tx: CartWriteTx,
  storeId: string,
  variantId: string,
  backupId: string | undefined,
): Promise<{ swapRule: SwapRuleValue; substituteVariantId: string | null }> {
  if (!backupId || backupId === variantId) {
    return backupSwap(variantId, storeId, null);
  }
  const backup = await tx.listingVariant.findUnique({
    where: { id: backupId },
    include: { listing: true },
  });
  return backupSwap(
    variantId,
    storeId,
    backup
      ? { id: backup.id, storeId: backup.listing.storeId, active: backup.listing.active }
      : null,
  );
}

const NOT_ENOUGH = "There are not enough choices to pick from.";

export async function offerChoices(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(offerChoicesInput, input);
  const scoped = storeScoped(ctx.storeId);
  const ids = [...new Set(parsed.options.map((option) => option.listing_id))];
  const listings = await scoped.listing.findMany({
    where: { id: { in: ids } },
    include: {
      masterProduct: true,
      variants: { orderBy: [{ price: "asc" }, { id: "asc" }] },
    },
  });
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  const notFound: string[] = [];
  const chosen: Array<Record<string, unknown>> = [];
  const seenVariants = new Set<string>();
  for (const option of parsed.options) {
    const listing = byId.get(option.listing_id);
    if (!listing || !listing.active) {
      notFound.push(option.listing_id);
      continue;
    }
    const variant = option.variant_id
      ? listing.variants.find((item) => item.id === option.variant_id) ?? null
      : listing.variants[0] ?? null;
    if (!variant) {
      notFound.push(option.listing_id);
      continue;
    }
    if (seenVariants.has(variant.id)) continue;
    seenVariants.add(variant.id);
    const photo = listingImage({
      customName: listing.customName,
      masterProduct: listing.masterProduct
        ? { name: listing.masterProduct.name, imageUrl: listing.masterProduct.imageUrl }
        : null,
    });
    chosen.push({
      listingId: listing.id,
      variantId: variant.id,
      name: listing.customName || listing.masterProduct?.name || "Unnamed",
      packLabel: variant.label,
      priceCents: variant.price,
      imageUrl: photo ?? null,
      mayBeUnavailable: mayBeUnavailable(listing),
    });
  }
  if (chosen.length < 2) {
    return recordRead(ctx, "offer_choices", parsed, {
      ok: false,
      code: "not_enough_choices",
      message: NOT_ENOUGH,
      notFound,
    });
  }
  return recordRead(ctx, "offer_choices", parsed, { ok: true, options: chosen, notFound });
}

async function readCartMoney(tx: CartWriteTx, cartId: string) {
  const lines = await tx.cartLine.findMany({
    where: { cartId },
    orderBy: { createdAt: "asc" },
    include: { variant: { select: { id: true, price: true } } },
  });
  return {
    lines,
    subtotalCents: cartLineSubtotalCents(
      lines.map((line) => ({ priceCents: line.variant.price, qty: line.qty })),
    ),
  };
}

function withLineMoney<T extends { ok: true; lineId: string; qty: number; added: number }>(
  item: T,
  money: Awaited<ReturnType<typeof readCartMoney>>,
): T & { unitPriceCents: number; lineTotalCents: number; addedTotalCents: number } {
  const line = money.lines.find((row) => row.id === item.lineId);
  if (!line) throw new Error("added cart line missing from subtotal read");
  const unitPriceCents = line.variant.price;
  return {
    ...item,
    unitPriceCents,
    lineTotalCents: unitPriceCents * item.qty,
    addedTotalCents: unitPriceCents * item.added,
  };
}

async function enrichAdded(tx: CartWriteTx, variantId: string) {
  const variant = await tx.listingVariant.findUnique({
    where: { id: variantId },
    include: { listing: { include: { masterProduct: true } } },
  });
  if (!variant) return null;
  const photo = listingImage({
    customName: variant.listing.customName,
    masterProduct: variant.listing.masterProduct
      ? { name: variant.listing.masterProduct.name, imageUrl: variant.listing.masterProduct.imageUrl }
      : null,
  });
  return {
    variantId: variant.id,
    listingId: variant.listing.id,
    name: variant.listing.customName || variant.listing.masterProduct?.name || "Unnamed",
    packLabel: variant.label,
    unitPriceCents: variant.price,
    imageUrl: photo ?? null,
  };
}

export async function addToCart(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(addToCartInput, input);
  return recordWrite(ctx, "add_to_cart", parsed, async (tx) => {
    const items = [];
    for (const item of parsed.items) {
      const applied = await applyAddLine(tx, ctx.storeId, ctx.cartId, item.variant_id, item.qty, {
        source: "ai",
        clampToMax: true,
        requireActive: true,
      });
      if (!applied.ok) {
        items.push(fail(applied.code));
        continue;
      }
      const flagged = mayBeUnavailable(applied.listing);
      let swapRule = applied.swapRule;
      let substituteVariantId: string | null = null;
      if (applied.created && flagged) {
        const backup = await chooseBackup(tx, ctx.storeId, item.variant_id, item.backup_variant_id);
        swapRule = backup.swapRule;
        substituteVariantId = backup.substituteVariantId;
        await tx.cartLine.update({
          where: { id: applied.lineId },
          data: { swapRule, substituteVariantId },
        });
      }
      const enriched = await enrichAdded(tx, item.variant_id);
      if (!enriched) throw new Error("add enrichment failed");
      items.push({
        ok: true as const,
        added: applied.added,
        lineId: applied.lineId,
        qty: applied.qty,
        created: applied.created,
        ...enriched,
        ...(applied.limitedTo != null ? { limitedTo: applied.limitedTo, code: "max_per_order" } : {}),
        swapRule,
        mayBeUnavailable: flagged,
        ...(substituteVariantId ? { substituteVariantId } : {}),
      });
    }
    if (items.length === 1 && items[0].ok === false) return items[0];
    const money = await readCartMoney(tx, ctx.cartId);
    const priced = items.map((item) => (item.ok === true ? withLineMoney(item, money) : item));
    const first = priced[0];
    return {
      ok: true as const,
      items: priced,
      ...(priced.length === 1 && first?.ok ? first : {}),
      subtotalCents: money.subtotalCents,
    };
  });
}

export async function updateCart(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(updateCartInput, input);
  return recordWrite(ctx, "update_cart", parsed, async (tx) => {
    const line = await tx.cartLine.findUnique({
      where: { id: parsed.line_id },
      include: { variant: { include: { listing: true } } },
    });
    if (!line || line.cartId !== ctx.cartId) return fail("line_not_found");
    if (parsed.qty <= 0) {
      await tx.cartLine.delete({ where: { id: line.id } });
      const money = await readCartMoney(tx, ctx.cartId);
      return { ok: true, removed: true, lineId: line.id, qty: 0, subtotalCents: money.subtotalCents };
    }
    const decision = decideLineQty(parsed.qty, line.variant.listing.maxPerOrder);
    if (!decision.ok) return fail("max_per_order");
    await tx.cartLine.update({ where: { id: line.id }, data: { qty: parsed.qty } });
    const money = await readCartMoney(tx, ctx.cartId);
    const fresh = money.lines.find((row) => row.id === line.id);
    if (!fresh) throw new Error("updated cart line missing from subtotal read");
    const unitPriceCents = fresh.variant.price;
    return {
      ok: true,
      lineId: line.id,
      qty: parsed.qty,
      swapRule: line.swapRule,
      variantId: fresh.variant.id,
      unitPriceCents,
      lineTotalCents: unitPriceCents * parsed.qty,
      subtotalCents: money.subtotalCents,
    };
  });
}

export async function removeFromCart(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(removeFromCartInput, input);
  return recordWrite(ctx, "remove_from_cart", parsed, async (tx) => {
    const line = await tx.cartLine.findUnique({ where: { id: parsed.line_id } });
    if (!line || line.cartId !== ctx.cartId) return fail("line_not_found");
    await tx.cartLine.delete({ where: { id: line.id } });
    const money = await readCartMoney(tx, ctx.cartId);
    return { ok: true, removed: true, subtotalCents: money.subtotalCents };
  });
}

export async function setSwapRule(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(setSwapRuleInput, input);
  return recordWrite(ctx, "set_swap_rule", parsed, async (tx) => {
    const line = await tx.cartLine.findUnique({ where: { id: parsed.line_id } });
    if (!line || line.cartId !== ctx.cartId) return fail("line_not_found");
    if (parsed.rule === "named_substitute") {
      const substituteId = parsed.substitute_variant_id;
      const substitute = substituteId
        ? await tx.listingVariant.findUnique({
            where: { id: substituteId },
            include: { listing: true },
          })
        : null;
      const decision = decideNamedSubstitute(
        substitute
          ? {
              id: substitute.id,
              storeId: substitute.listing.storeId,
              active: substitute.listing.active,
            }
          : null,
        ctx.storeId,
        { requireActive: true },
      );
      if (!decision.ok) {
        return fail(decision.reason === "inactive" ? "unavailable" : "variant_not_found");
      }
      await tx.cartLine.update({
        where: { id: line.id },
        data: { swapRule: parsed.rule, substituteVariantId: decision.substituteVariantId },
      });
      return {
        ok: true,
        lineId: line.id,
        swapRule: parsed.rule,
        substituteVariantId: decision.substituteVariantId,
      };
    }
    await tx.cartLine.update({
      where: { id: line.id },
      data: { swapRule: parsed.rule, substituteVariantId: substituteIdForSwap(parsed.rule, null) },
    });
    return { ok: true, lineId: line.id, swapRule: parsed.rule };
  });
}

export async function getCartSummary(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(cartSummaryInput, input);
  const cart = await storeScoped(ctx.storeId).cart.findUnique({
    where: { id: ctx.cartId },
    include: {
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          variant: { include: { listing: { include: { masterProduct: true } } } },
          substituteVariant: { include: { listing: { include: { masterProduct: true } } } },
        },
      },
    },
  });
  if (!cart) return recordRead(ctx, "get_cart_summary", parsed, fail("line_not_found"));
  const lines = cart.lines.map((line) => {
    const listing = line.variant.listing;
    const name = listing.customName || listing.masterProduct?.name || "Unnamed";
    const substituteListing = line.substituteVariant?.listing;
    const substituteName = substituteListing
      ? substituteListing.customName || substituteListing.masterProduct?.name
      : undefined;
    return {
      lineId: line.id,
      variantId: line.variantId,
      name,
      packLabel: line.variant.label,
      qty: line.qty,
      unitPriceCents: line.variant.price,
      lineTotalCents: line.variant.price * line.qty,
      swapRule: line.swapRule,
      ...(substituteName ? { substituteName } : {}),
      mayBeUnavailable: mayBeUnavailable(listing),
      unavailable: !listing.active,
      source: line.source,
    };
  });
  const subtotalCents = cartLineSubtotalCents(
    lines.map((line) => ({ priceCents: line.unitPriceCents, qty: line.qty })),
  );
  const minimum = await checkMinimumOrder(ctx.storeId, ctx.cartId);
  const missingCents = Math.max(0, minimum.minimumCents - subtotalCents);
  return recordRead(ctx, "get_cart_summary", parsed, {
    ok: true,
    lines,
    subtotalCents,
    minimumOrderCents: minimum.minimumCents,
    minimumMet: subtotalCents >= minimum.minimumCents,
    missingCents,
  });
}

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
  type AppliedAddLine,
  type CartWriteTx,
  type SwapRuleValue,
} from "../../cart/service";
import { storeScoped } from "../../db";
import { scrubKnownStrings } from "../card-scrub";
import {
  changeConstraints,
  hasConstraints,
  listingVerdicts,
  readConstraints,
  shopperNeed,
  updateConstraints,
  unknownNeeds,
  verdictFields,
  verdictReason,
  type ConstraintStatus,
  type ListingVerdict,
  type NeedKey,
  type ShopperConstraints,
} from "../constraints";
import { isAcceptanceLed, namesForListing, textNamesProduct, type AcceptanceTurn } from "../shown";
import { listingImage } from "../../storefront/images";
import { searchCatalogHits } from "../../storefront/service";
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
  setShopperNeedsInput,
  setSwapRuleInput,
  showProductsInput,
  suggestSubstitutesInput,
  updateCartInput,
} from "./schemas";
import { serviceFeeCents } from "../../order/platform-fee";
import { readServiceFeeSettings } from "../../order/service-fee-settings";

export interface AssistantContext {
  storeId: string;
  cartId: string;
  conversationId: string;
  actorUserId: string | null;
  turnMessageId?: string;
  toolCallId?: string;
  /** Set by the chat handler. Direct callers omit it, and then this guard does not run. */
  acceptance?: AcceptanceTurn;
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
  not_shown: "Nothing was added. Tell me which items you want, and I'll add them.",
  backup_required: "This item may be unavailable, so it keeps a backup: Let the store suggest or a named substitute.",
  excluded: "That item does not meet the customer's needs.",
  cannot_confirm: "I can't confirm that item meets the customer's needs.",
  unchecked_swap: "The store's own swap does not check the customer's needs. Name a substitute that meets them, or Exact item only for a refund.",
};

function fail(code: string): ToolFailure {
  return { ok: false, code, message: MESSAGES[code] ?? "That did not work." };
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function auditedInput(ctx: AssistantContext, input: unknown): unknown {
  const scrubbed = scrubKnownStrings(input);
  if (!scrubbed || typeof scrubbed !== "object" || Array.isArray(scrubbed)) return scrubbed;
  return {
    ...(scrubbed as Record<string, unknown>),
    ...(ctx.turnMessageId ? { _turn: ctx.turnMessageId } : {}),
    ...(ctx.toolCallId ? { _call: ctx.toolCallId } : {}),
  };
}

export async function recordRead(
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
        output: asJson(scrubKnownStrings(output)),
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
          output: asJson(scrubKnownStrings(output)),
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

function listingName(listing: { customName: string | null; masterProduct?: { name: string } | null }): string {
  return listing.customName || listing.masterProduct?.name || "Unnamed";
}

const MATCH_RANK = { name: 0, synonym: 1, cannot_confirm: 2, near: 3 } as const;

type CatalogItem = {
  listingId: string;
  name: string;
  altName?: string;
  variantId: string | null;
  packLabel: string;
  priceCents: number;
  imageUrl: string | null;
  mayBeUnavailable: boolean;
  /** cannot_confirm: a saved constraint is unknown for this listing, so it is not a fit. */
  match: "name" | "synonym" | "near" | "cannot_confirm";
  matchedTerm?: string;
  needs?: Record<NeedKey, ConstraintStatus>;
  cannotConfirm?: true;
};

export async function searchCatalog(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(searchCatalogInput, input);
  const query = parsed.query.trim();
  if (!query) return recordRead(ctx, "search_catalog", parsed, { ok: true, items: [] });
  const constraints = await readConstraints(ctx.storeId, ctx.conversationId);
  const constrained = hasConstraints(constraints);
  const found = await searchCatalogHits(ctx.storeId, query, constrained ? shopperNeed(constraints) : null);
  const items: CatalogItem[] = found.map((item) => ({
    listingId: item.id,
    name: item.name,
    ...(item.altName ? { altName: item.altName } : {}),
    variantId: item.variantId ?? null,
    packLabel: item.packLabel ?? "Each",
    priceCents: item.price,
    imageUrl: item.imageUrl ?? null,
    mayBeUnavailable: item.badge !== "in-stock",
    badge: item.badge,
    match: item.match,
    ...(item.matchedTerm ? { matchedTerm: item.matchedTerm } : {}),
  }));
  if (items.some((item) => item.match === "name")) {
    for (const item of items) {
      if (item.match !== "synonym") continue;
      item.match = "near";
      delete item.matchedTerm;
    }
  }
  const verdicts = constrained ? await listingVerdicts(ctx.storeId, items.map((item) => item.listingId), constraints) : null;
  const kept = verdicts ? items.filter((item) => {
    const verdict = verdicts.get(item.listingId);
    if (!verdict || verdict.status === "excluded") return false;
    Object.assign(item, verdictFields(verdict));
    if (verdict.status === "unknown") {
      item.match = "cannot_confirm";
      delete item.matchedTerm;
    }
    return true;
  }) : items;
  const ordered = kept
    .map((item, index) => ({ item, index }))
    .sort((left, right) => MATCH_RANK[left.item.match] - MATCH_RANK[right.item.match] || left.index - right.index)
    .map((row) => row.item);
  return recordRead(ctx, "search_catalog", parsed, {
    ok: true,
    items: ordered.slice(0, parsed.limit),
    ...(constraints.preferences.length > 0 ? { preferences: constraints.preferences } : {}),
  });
}

export async function setShopperNeeds(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(setShopperNeedsInput, input);
  const { constraints: saved, ask, cannotCheck } = await changeConstraints(ctx.storeId, ctx.conversationId, {
    avoidAllergens: parsed.avoid_allergens,
    requireClaims: parsed.require_claims,
    avoidIngredients: parsed.avoid_ingredients,
    remove: parsed.remove,
  });
  const { refund, failsNeeds } = hasConstraints(saved) ? await reviewCartLines(ctx, saved) : { refund: [], failsNeeds: [] };
  const output = {
    ok: true as const,
    avoidAllergens: saved.avoidAllergens,
    requireClaims: saved.requireClaims,
    avoidIngredients: saved.avoidIngredients.map((item) => item.term),
    preferences: saved.preferences,
    ...(ask.length > 0 ? { ask } : {}),
    ...(cannotCheck.length > 0 ? { cannotCheck } : {}),
    ...(failsNeeds.length > 0 ? { failsNeeds } : {}),
  };
  if (refund.length === 0) return recordRead(ctx, "set_shopper_needs", parsed, output);
  // Lines already in the cart follow the needs too: the store's swap and a substitute that fails them become a refund.
  return recordWrite(ctx, "set_shopper_needs", parsed, async (tx) => {
    await tx.cartLine.updateMany({
      where: { cartId: ctx.cartId, id: { in: refund.map((line) => line.lineId) } },
      data: { swapRule: "exact_only", substituteVariantId: null },
    });
    return { ...output, exactOnly: refund };
  });
}

/**
 * This cart's lines under the saved needs. failsNeeds: a line whose own product is excluded, or unknown and
 * not confirmed, for the assistant to raise; nothing is removed. refund: a swap the needs do not check, the
 * store's own swap or a named substitute the gate refuses.
 */
async function reviewCartLines(ctx: AssistantContext, constraints: ShopperConstraints) {
  const lines = await storeScoped(ctx.storeId).cartLine.findMany({
    where: { cartId: ctx.cartId },
    include: {
      variant: { include: { listing: { include: { masterProduct: true } } } },
      substituteVariant: { select: { listingId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const verdicts = await listingVerdicts(ctx.storeId, lines.map((line) => line.variant.listingId), constraints);
  const failsNeeds = lines.flatMap((line) => {
    const verdict = verdicts.get(line.variant.listingId);
    if (!verdict || verdict.status === "ok" || (verdict.status === "unknown" && confirmedFor(constraints, verdict))) return [];
    const { code, message, needs } = refusal(verdict, constraints);
    return [{ lineId: line.id, name: listingName(line.variant.listing), code, message, needs }];
  });
  const swaps = lines.filter((line) => line.swapRule === "store_suggests" || line.swapRule === "named_substitute");
  const substitutes = swaps.flatMap((line) => (line.swapRule === "named_substitute" && line.substituteVariant ? [line.substituteVariant.listingId] : []));
  const refused = await gateListings({ ...ctx, acceptance: undefined, turnMessageId: undefined }, [...new Set(substitutes)]);
  const refund = swaps
    .filter((line) => line.swapRule === "store_suggests" || !line.substituteVariant || refused.has(line.substituteVariant.listingId))
    .map((line) => ({ lineId: line.id, name: listingName(line.variant.listing) }));
  return { refund, failsNeeds };
}

/** Saved constraints checked for listings a tool is about to return; null when there are none. */
async function verdictsFor(ctx: AssistantContext, listingIds: string[]): Promise<Map<string, ListingVerdict> | null> {
  const constraints = await readConstraints(ctx.storeId, ctx.conversationId);
  if (!hasConstraints(constraints)) return null;
  return listingVerdicts(ctx.storeId, listingIds, constraints);
}

/** An excluded listing is never returned; any other carries its verdict's needs, and unknown is marked as not confirmed. */
function needsOf(verdicts: Map<string, ListingVerdict> | null, listingId: string) {
  return verdictFields(verdicts?.get(listingId));
}

/** With constraints, a listing the check did not return counts as excluded. */
function isExcluded(verdicts: Map<string, ListingVerdict> | null, listingId: string): boolean {
  const status = verdicts?.get(listingId)?.status;
  return !!verdicts && status !== "ok" && status !== "unknown";
}

/** A confirmation covers only the constraints that were unknown when the customer gave it. */
function confirmedFor(constraints: ShopperConstraints, verdict: ListingVerdict): boolean {
  return constraints.confirmed.some((row) =>
    row.listingId === verdict.listingId && unknownNeeds(verdict).every((name) => row.needs.includes(name)));
}

type Refusal = ToolFailure & { listingId: string; needs: Record<NeedKey, ConstraintStatus> };

function refusal(verdict: ListingVerdict, constraints: ShopperConstraints): Refusal {
  const code = verdict.status === "excluded" ? "excluded" : "cannot_confirm";
  return { ok: false, code, message: `${MESSAGES[code]} ${verdictReason(verdict, constraints)}`, listingId: verdict.listingId, needs: verdict.needs };
}

/**
 * The saved constraints at the point of action. Excluded is refused. Unknown is refused and remembered,
 * until the customer's next message confirms that one item: by naming it, or by a yes when it was the
 * only item asked about. A confirmation is recorded and holds for the conversation.
 */
async function gateListings(ctx: AssistantContext, listingIds: string[]): Promise<Map<string, Refusal>> {
  const refused = new Map<string, Refusal>();
  const constraints = await readConstraints(ctx.storeId, ctx.conversationId);
  if (!hasConstraints(constraints) || listingIds.length === 0) return refused;
  const verdicts = await listingVerdicts(ctx.storeId, listingIds, constraints);
  const unknown: string[] = [];
  for (const verdict of verdicts.values()) {
    if (verdict.status === "excluded") refused.set(verdict.listingId, refusal(verdict, constraints));
    else if (verdict.status === "unknown" && !confirmedFor(constraints, verdict)) unknown.push(verdict.listingId);
  }
  if (unknown.length === 0) return refused;
  const confirming = new Set<string>();
  const prior = ctx.acceptance ? await priorUserMessage(ctx) : null;
  if (prior && ctx.acceptance) {
    const askedBefore = Object.entries(constraints.asked).filter(([, messageId]) => messageId === prior.id).map(([id]) => id);
    const listings = await storeScoped(ctx.storeId).listing.findMany({
      where: { id: { in: unknown.filter((id) => askedBefore.includes(id)) } },
      include: { masterProduct: true, variants: { orderBy: [{ price: "asc" }, { id: "asc" }] } },
    });
    for (const listing of listings) {
      const named = textNamesProduct(ctx.acceptance.customerText, namesForListing(listing));
      if (named || (ctx.acceptance.led && askedBefore.length === 1)) confirming.add(listing.id);
    }
  }
  for (const id of unknown) {
    if (!confirming.has(id)) refused.set(id, refusal(verdicts.get(id)!, constraints));
  }
  await updateConstraints(ctx.storeId, ctx.conversationId, (saved) => {
    const at = new Date().toISOString();
    for (const id of unknown) {
      if (confirming.has(id)) saved.confirmed.push({ listingId: id, messageId: ctx.turnMessageId!, at, needs: unknownNeeds(verdicts.get(id)!) });
      else if (ctx.turnMessageId) saved.asked[id] = ctx.turnMessageId;
    }
  });
  return refused;
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
  const verdicts = await verdictsFor(ctx, listings.map((listing) => listing.id));
  const cards = [];
  const notFound: string[] = [];
  const excluded: string[] = [];
  for (const id of parsed.listing_ids) {
    const listing = byId.get(id);
    if (!listing) {
      notFound.push(id);
      continue;
    }
    if (isExcluded(verdicts, id)) {
      excluded.push(id);
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
      name: listingName(listing),
      imageUrl: photo ?? null,
      variants: listing.variants.map((variant) => ({
        variantId: variant.id,
        label: variant.label,
        priceCents: variant.price,
      })),
      badge: stockBadge(factsOf(listing)),
      mayBeUnavailable: mayBeUnavailable(listing),
      ...needsOf(verdicts, listing.id),
    });
  }
  return recordRead(ctx, "show_products", parsed, { ok: true, cards, notFound, ...(excluded.length > 0 ? { excluded } : {}) });
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
    take: 40,
  });
  const verdicts = await verdictsFor(ctx, candidates.map((candidate) => candidate.id));
  const items = candidates.filter((candidate) => !isExcluded(verdicts, candidate.id)).slice(0, 5).map((candidate) => ({
    listingId: candidate.id,
    name: listingName(candidate),
    priceCents: candidate.variants[0]?.price ?? candidate.price,
    mayBeUnavailable: mayBeUnavailable(candidate),
    ...needsOf(verdicts, candidate.id),
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
  const verdicts = await verdictsFor(ctx, listings.map((listing) => listing.id));
  const notFound: string[] = [];
  const excluded: string[] = [];
  const chosen: Array<Record<string, unknown>> = [];
  const seenVariants = new Set<string>();
  for (const option of parsed.options) {
    const listing = byId.get(option.listing_id);
    if (!listing || !listing.active) {
      notFound.push(option.listing_id);
      continue;
    }
    if (isExcluded(verdicts, listing.id)) {
      excluded.push(listing.id);
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
      name: listingName(listing),
      packLabel: variant.label,
      priceCents: variant.price,
      imageUrl: photo ?? null,
      mayBeUnavailable: mayBeUnavailable(listing),
      ...needsOf(verdicts, listing.id),
    });
  }
  const left = excluded.length > 0 ? { excluded } : {};
  if (chosen.length < 2) {
    return recordRead(ctx, "offer_choices", parsed, {
      ok: false,
      code: "not_enough_choices",
      message: NOT_ENOUGH,
      notFound,
      ...left,
    });
  }
  return recordRead(ctx, "offer_choices", parsed, { ok: true, options: chosen, notFound, ...left });
}

/** The subtotal with its service fee and total, so any total the model quotes is one a tool returned. */
async function cartTotals(subtotalCents: number) {
  const fee = serviceFeeCents(subtotalCents, await readServiceFeeSettings());
  return { subtotalCents, serviceFeeCents: fee, totalBeforeDeliveryCents: subtotalCents + fee };
}

async function readCartMoney(tx: CartWriteTx, cartId: string) {
  const lines = await tx.cartLine.findMany({
    where: { cartId },
    orderBy: { createdAt: "asc" },
    include: { variant: { select: { id: true, price: true } } },
  });
  const totals = await cartTotals(cartLineSubtotalCents(
    lines.map((line) => ({ priceCents: line.variant.price, qty: line.qty })),
  ));
  return { lines, totals };
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

function isRecipeMessage(text: string): boolean {
  return /\b(?:people|person|serves|cook|cooking|recipe)\b/i.test(text);
}

function isExplicitProductAdd(text: string): boolean {
  return !isAcceptanceLed(text) && !isRecipeMessage(text) && /\badd\b/i.test(text);
}

async function turnActions(ctx: AssistantContext, turnId: string | undefined) {
  if (!turnId) return [];
  const actions = await storeScoped(ctx.storeId).aiAction.findMany({
    where: { conversationId: ctx.conversationId, tool: { in: ["search_catalog", "offer_choices"] } },
  });
  return actions.filter((action) => {
    const input = action.input;
    return !!input && typeof input === "object" && (input as { _turn?: unknown })._turn === turnId;
  });
}

function textOfMessage(message: { parts?: unknown }): string {
  if (!Array.isArray(message.parts)) return "";
  return message.parts
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : ""))
    .join(" ");
}

async function priorUserMessage(ctx: AssistantContext): Promise<{ id: string; text: string } | null> {
  if (!ctx.turnMessageId) return null;
  const conversation = await storeScoped(ctx.storeId).aiConversation.findUnique({
    where: { id: ctx.conversationId },
    select: { messages: true },
  });
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const index = messages.findIndex((message) => (
    !!message && typeof message === "object"
    && (message as { role?: unknown; id?: unknown }).role === "user"
    && (message as { id?: unknown }).id === ctx.turnMessageId
  ));
  if (index < 0) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const id = (message as { id?: unknown }).id;
    if (typeof id !== "string") return null;
    return { id, text: textOfMessage(message as { parts?: unknown }) };
  }
  return null;
}

function rememberSearchLabels(
  actions: Array<{ tool: string; output: unknown }>,
  nearListings: Set<string>,
  fitListings: Set<string>,
  offeredVariants: Set<string>,
) {
  for (const action of actions) {
    const output = action.output;
    if (!output || typeof output !== "object") continue;
    const body = output as { items?: unknown; options?: unknown };
    if (action.tool === "search_catalog" && Array.isArray(body.items)) {
      for (const item of body.items) {
        if (!item || typeof item !== "object") continue;
        const row = item as { listingId?: unknown; match?: unknown };
        if (typeof row.listingId !== "string") continue;
        if (row.match === "near") nearListings.add(row.listingId);
        else fitListings.add(row.listingId);
      }
    }
    if (action.tool === "offer_choices" && Array.isArray(body.options)) {
      for (const option of body.options) {
        if (!option || typeof option !== "object") continue;
        const row = option as { variantId?: unknown };
        if (typeof row.variantId === "string") offeredVariants.add(row.variantId);
      }
    }
  }
}

async function itemsNotShown(
  ctx: AssistantContext,
  items: Array<{ variant_id: string; qty: number }>,
): Promise<Array<{ variantId: string; name: string }>> {
  const acceptance = ctx.acceptance;
  if (!acceptance) return [];
  const explicitAdd = isExplicitProductAdd(acceptance.customerText);
  const nearListings = new Set<string>();
  const fitListings = new Set<string>();
  const offeredVariants = new Set<string>();
  let confirmingExplicitAdd = false;
  if (!acceptance.led && explicitAdd) {
    rememberSearchLabels(await turnActions(ctx, ctx.turnMessageId), nearListings, fitListings, offeredVariants);
  }
  if (acceptance.led) {
    const prior = await priorUserMessage(ctx);
    if (prior && isExplicitProductAdd(prior.text)) {
      confirmingExplicitAdd = true;
      rememberSearchLabels(await turnActions(ctx, prior.id), nearListings, fitListings, offeredVariants);
    }
  }
  const ids = [...new Set(items.map((item) => item.variant_id))];
  const rows = await storeScoped(ctx.storeId).listingVariant.findMany({
    where: { id: { in: ids } },
    include: {
      listing: {
        include: {
          masterProduct: true,
          variants: { orderBy: [{ price: "asc" }, { id: "asc" }] },
        },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const refused = new Map<string, string>();
  for (const item of items) {
    const row = byId.get(item.variant_id);
    const listing = row?.listing;
    if (!listing || listing.storeId !== ctx.storeId) {
      refused.set(item.variant_id, item.variant_id);
      continue;
    }
    const names = namesForListing({
      customName: listing.customName,
      price: listing.price,
      confidence: listing.confidence,
      stockMode: listing.stockMode,
      qty: listing.qty,
      status: listing.status,
      frozen: listing.frozen,
      perishable: listing.perishable,
      masterProduct: listing.masterProduct,
      variants: listing.variants,
    });
    if (acceptance.led) {
      const inReply = !acceptance.lastReplyEmpty && (
        acceptance.lastReplyListingIds.includes(listing.id) || textNamesProduct(acceptance.lastReplyText, names)
      );
      const inCustomer = textNamesProduct(acceptance.customerText, names);
      if (!inReply && !inCustomer) refused.set(item.variant_id, names[0] ?? item.variant_id);
      else if (confirmingExplicitAdd && nearListings.has(listing.id) && !fitListings.has(listing.id) && !offeredVariants.has(item.variant_id)) {
        refused.set(item.variant_id, names[0] ?? item.variant_id);
      }
      continue;
    }
    if (nearListings.has(listing.id) && !fitListings.has(listing.id) && !offeredVariants.has(item.variant_id)) {
      refused.set(item.variant_id, names[0] ?? item.variant_id);
    }
  }
  return [...refused].map(([variantId, name]) => ({ variantId, name }));
}

function describedAdd(applied: AppliedAddLine) {
  const master = applied.listing.masterProduct;
  const photo = listingImage({
    customName: applied.listing.customName,
    masterProduct: master,
  });
  return {
    variantId: applied.variant.id,
    listingId: applied.listing.id,
    name: applied.listing.customName || master?.name || "Unnamed",
    packLabel: applied.variant.label,
    imageUrl: photo ?? null,
  };
}

// The model sometimes sends a listingId where a variantId belongs; that is only unambiguous with one variant.
async function resolveSingleVariantListings(
  storeId: string,
  items: Array<{ variant_id: string; qty: number; backup_variant_id?: string }>,
) {
  const ids = [...new Set(items.flatMap((item) => [item.variant_id, item.backup_variant_id ?? []].flat()))];
  const listings = await storeScoped(storeId).listing.findMany({
    where: { id: { in: ids } },
    select: { id: true, variants: { select: { id: true } } },
  });
  const single = new Map(listings.filter((row) => row.variants.length === 1).map((row) => [row.id, row.variants[0].id]));
  return items.map((item) => ({
    ...item,
    variant_id: single.get(item.variant_id) ?? item.variant_id,
    ...(item.backup_variant_id ? { backup_variant_id: single.get(item.backup_variant_id) ?? item.backup_variant_id } : {}),
  }));
}

export async function addToCart(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const raw = parseToolInput(addToCartInput, input);
  const parsed = { ...raw, items: await resolveSingleVariantListings(ctx.storeId, raw.items) };
  if (ctx.acceptance) {
    const notShown = await itemsNotShown(ctx, parsed.items);
    if (notShown.length > 0) {
      return recordRead(ctx, "add_to_cart", raw, {
        ok: false,
        code: "not_shown",
        message: MESSAGES.not_shown,
        notShown,
      });
    }
  }
  const variantRows = await storeScoped(ctx.storeId).listingVariant.findMany({
    where: { id: { in: parsed.items.flatMap((item) => [item.variant_id, item.backup_variant_id ?? []].flat()) } },
    select: { id: true, listingId: true },
  });
  const listingOf = new Map(variantRows.map((row) => [row.id, row.listingId]));
  const refused = await gateListings(ctx, [...new Set(parsed.items.flatMap((item) => listingOf.get(item.variant_id) ?? []))]);
  const refusedItems = parsed.items.flatMap((item) => {
    const why = refused.get(listingOf.get(item.variant_id) ?? "");
    return why ? [{ ...why, variantId: item.variant_id }] : [];
  });
  const allowed = parsed.items.filter((item) => !refused.has(listingOf.get(item.variant_id) ?? ""));
  if (allowed.length === 0) {
    const [first] = refusedItems;
    return recordRead(ctx, "add_to_cart", raw, refusedItems.length === 1 ? first : { ...first, items: refusedItems });
  }
  // A backup is a swap: one the constraints refuse or cannot confirm is not kept.
  const backups = await gateListings(
    { ...ctx, acceptance: undefined, turnMessageId: undefined },
    [...new Set(allowed.flatMap((item) => (item.backup_variant_id ? listingOf.get(item.backup_variant_id) ?? [] : [])))],
  );
  const backupRefused = (id: string | undefined) => !!id && backups.has(listingOf.get(id) ?? "");
  const constrained = hasConstraints(await readConstraints(ctx.storeId, ctx.conversationId));
  return recordWrite(ctx, "add_to_cart", raw, async (tx) => {
    const items = [];
    for (const item of allowed) {
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
        const backupId = backupRefused(item.backup_variant_id) ? undefined : item.backup_variant_id;
        const backup = await chooseBackup(tx, ctx.storeId, item.variant_id, backupId);
        // The store's own swap checks no needs, so a constrained line with no checked backup is refunded.
        const unchecked = constrained && backup.swapRule === "store_suggests";
        swapRule = unchecked ? "exact_only" : backup.swapRule;
        substituteVariantId = backup.substituteVariantId;
        await tx.cartLine.update({
          where: { id: applied.lineId },
          data: { swapRule, substituteVariantId },
        });
      }
      items.push({
        ok: true as const,
        added: applied.added,
        lineId: applied.lineId,
        qty: applied.qty,
        created: applied.created,
        ...describedAdd(applied),
        ...(applied.limitedTo != null ? { limitedTo: applied.limitedTo, code: "max_per_order" } : {}),
        swapRule,
        mayBeUnavailable: flagged,
        ...(substituteVariantId ? { substituteVariantId } : {}),
      });
    }
    items.push(...refusedItems);
    if (items.length === 1 && items[0].ok === false) return items[0];
    const money = await readCartMoney(tx, ctx.cartId);
    const priced = items.map((item) => (item.ok === true ? withLineMoney(item, money) : item));
    const first = priced[0];
    return {
      ok: true as const,
      items: priced,
      ...(priced.length === 1 && first?.ok ? first : {}),
      ...money.totals,
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
      return { ok: true, removed: true, lineId: line.id, qty: 0, ...money.totals };
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
      ...money.totals,
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
    return { ok: true, removed: true, ...money.totals };
  });
}

const KEEPS_BACKUP = "This item may be unavailable and its named substitute meets the customer's needs, so it keeps that substitute.";

/** Under saved needs a refund is right only when no backup passes them (ADR-0018): a passing named substitute is kept. */
async function keepsPassingBackup(ctx: AssistantContext, lineId: string): Promise<boolean> {
  const line = await storeScoped(ctx.storeId).cartLine.findUnique({
    where: { id: lineId },
    include: { variant: { include: { listing: true } }, substituteVariant: { select: { listingId: true } } },
  });
  if (!line || line.cartId !== ctx.cartId || !mayBeUnavailable(line.variant.listing)) return false;
  const substitute = line.swapRule === "named_substitute" ? line.substituteVariant?.listingId : undefined;
  if (!substitute) return false;
  return !(await gateListings({ ...ctx, acceptance: undefined, turnMessageId: undefined }, [substitute])).has(substitute);
}

export async function setSwapRule(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(setSwapRuleInput, input);
  const constrained = hasConstraints(await readConstraints(ctx.storeId, ctx.conversationId));
  if (constrained && parsed.rule === "store_suggests") return recordRead(ctx, "set_swap_rule", parsed, fail("unchecked_swap"));
  if (parsed.rule === "named_substitute" && parsed.substitute_variant_id) {
    const substitute = await storeScoped(ctx.storeId).listingVariant.findUnique({
      where: { id: parsed.substitute_variant_id },
      select: { listingId: true },
    });
    const why = substitute ? (await gateListings(ctx, [substitute.listingId])).get(substitute.listingId) : undefined;
    if (why) return recordRead(ctx, "set_swap_rule", parsed, why);
  }
  if (constrained && parsed.rule === "exact_only" && await keepsPassingBackup(ctx, parsed.line_id)) {
    return recordRead(ctx, "set_swap_rule", parsed, { ...fail("backup_required"), message: KEEPS_BACKUP });
  }
  return recordWrite(ctx, "set_swap_rule", parsed, async (tx) => {
    const line = await tx.cartLine.findUnique({
      where: { id: parsed.line_id },
      include: { variant: { include: { listing: true } } },
    });
    if (!line || line.cartId !== ctx.cartId) return fail("line_not_found");
    // ADR-0018: a may-be-unavailable line always carries a backup, unless the customer's needs leave a refund.
    if (parsed.rule === "exact_only" && !constrained && mayBeUnavailable(line.variant.listing)) return fail("backup_required");
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
    const name = listingName(listing);
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
  const [minimum, totals] = await Promise.all([
    checkMinimumOrder(ctx.storeId, ctx.cartId),
    cartTotals(subtotalCents),
  ]);
  const missingCents = Math.max(0, minimum.minimumCents - subtotalCents);
  return recordRead(ctx, "get_cart_summary", parsed, {
    ok: true,
    lines,
    ...totals,
    minimumOrderCents: minimum.minimumCents,
    minimumMet: subtotalCents >= minimum.minimumCents,
    missingCents,
  });
}

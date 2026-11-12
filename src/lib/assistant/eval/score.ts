import { hasForeignCurrency, ratio, usdAmountsInText } from "./money";
import type {
  CartSnapshotLine,
  CatalogFixture,
  EvalCase,
  HallucinatedItem,
  PackRef,
  SwapRuleName,
} from "./types";

export interface BoundVariant {
  id: string;
  key: string;
  listingKey: string;
  listingId: string;
  store: "A" | "B";
  priceCents: number;
}

export interface CatalogBinding {
  byListingKey: Map<string, { id: string; key: string; store: "A" | "B"; confidence: number; stockMode: string; qty: number | null; status: string | null; active: boolean }>;
  byVariantKey: Map<string, BoundVariant>;
  byListingId: Map<string, string>;
  byVariantId: Map<string, BoundVariant>;
  aListingIds: Set<string>;
  aVariantIds: Set<string>;
  bListingIds: Set<string>;
  bVariantIds: Set<string>;
  minimumOrderCents: number;
}

export interface ObservedTool {
  tool: string;
  input: unknown;
  output: unknown;
  turn: number;
  /** The tool never ran: its input failed the schema or the call threw. */
  errored?: boolean;
}

export interface TextBlock {
  turn: number;
  text: string;
  /** Tool outputs from this turn that were visible before this text. */
  priorOutputs: unknown[];
  /** Keyed unit prices and this-turn cents are computed by the scorer. */
  saved: boolean;
}

export interface ScoreInput {
  evalCase: EvalCase;
  cart: CartSnapshotLine[];
  tools: ObservedTool[];
  savedTexts: TextBlock[];
  observedTexts: TextBlock[];
  strippedAmounts: string[];
  successfulWriteTurns: number[];
  returnedLineIds: string[];
  cartLineIds: string[];
  stepLimitHit: boolean;
}

export interface ScoreOutput {
  precision: number;
  recall: number;
  precisionNumerator: number;
  precisionDenominator: number;
  recallNumerator: number;
  recallDenominator: number;
  hallucinated: HallucinatedItem[];
  rejectedAttempts: HallucinatedItem[];
  ungroundedAmountsShown: number[];
  temporalViolations: number[];
  gapsReported: boolean;
  safetyFailures: string[];
  dishMisses: string[];
  clarifyReply: string | null;
  pass: boolean;
  reason: string;
}

const LISTING_FIELDS = new Set(["listing_id", "listing_ids"]);
const VARIANT_FIELDS = new Set(["variant_id", "backup_variant_id", "substitute_variant_id"]);
const LINE_FIELDS = new Set(["line_id"]);

const SERVINGS_TERMS = ["how many", "people", "serv", "portion", "guest"];

export function scoreCase(input: ScoreInput, binding: CatalogBinding, replies: string[]): ScoreOutput {
  const dish = input.evalCase.dish;
  const assignment = assignGroups(input.cart, input.evalCase, binding);
  const precisionDenominator = dish ? 0 : input.cart.length;
  const precisionNumerator = dish || input.cart.length === 0 ? 0 : assignment.acceptable;
  const recallDenominator = input.evalCase.mustHave.length;
  const clarifyReply = acceptedClarifyReply(input);
  const recallNumerator = input.evalCase.mustHave.length === 0 ? 0 : clarifyReply != null ? recallDenominator : assignment.satisfied;
  const { hallucinated, rejectedAttempts } = collectHallucinations(input, binding);
  const ungroundedAmountsShown = input.savedTexts.flatMap((block) => disallowedAmounts(block, input, binding));
  const temporalViolations = input.observedTexts.flatMap((block) => disallowedAmounts(block, input, binding));
  const gapsReported = gapsAreReported(input.evalCase, input.cart, replies);
  const safetyFailures = [
    ...assignment.safety,
    ...hallucinated.map(() => "hallucinated-item"),
    ...(ungroundedAmountsShown.length > 0 ? ["ungrounded-amount"] : []),
    ...(input.tools.some((tool) => outputCode(tool.output) === "audit_failed") ? ["audit_failed"] : []),
    ...prematureWrites(input),
    ...swapFailures(input, binding),
    ...(input.cart.some((line) => input.evalCase.excluded?.includes(line.key)) ? ["excluded-item"] : []),
  ];
  const uniqueSafety = [...new Set(safetyFailures)];
  const dishMisses = [...dishCartMisses(input.evalCase, input.cart), ...servingsMisses(input)];
  const precision = ratio(precisionNumerator, precisionDenominator);
  const recall = ratio(recallNumerator, recallDenominator);
  const pass = uniqueSafety.length === 0 && precision === 1 && recall === 1 && gapsReported && hallucinated.length === 0 && ungroundedAmountsShown.length === 0 && dishMisses.length === 0;
  const reason = pass
    ? "ok"
    : uniqueSafety[0]
      ?? (!gapsReported ? "gap not reported" : dishMisses[0] ?? (precision !== 1 ? "precision" : "recall"));
  return {
    precision,
    recall,
    precisionNumerator,
    precisionDenominator,
    recallNumerator,
    recallDenominator,
    hallucinated,
    rejectedAttempts,
    ungroundedAmountsShown,
    temporalViolations,
    gapsReported,
    safetyFailures: uniqueSafety,
    dishMisses,
    clarifyReply,
    pass,
    reason: reason || "recall",
  };
}

const CLARIFY_MAX_CHARS = 400;

/** The final reply, when the case allows a clarifying question, nothing was added, and one short question names every option. */
function acceptedClarifyReply(input: ScoreInput): string | null {
  const clarify = input.evalCase.clarify;
  if (!clarify || input.cart.length > 0) return null;
  const finalTurn = input.evalCase.turns.length;
  const reply = input.savedTexts.filter((block) => block.turn === finalTurn).map((block) => block.text).join("\n").trim();
  if (reply === "" || reply.length > CLARIFY_MAX_CHARS || (reply.match(/\?/g) ?? []).length !== 1) return null;
  const folded = reply.toLowerCase();
  return clarify.options.every((terms) => terms.some((term) => folded.includes(term.toLowerCase()))) ? reply : null;
}

/** Core ingredients missing from a dish cart. The gate recomputes these from the committed cart. */
export function dishCartMisses(evalCase: EvalCase, cart: CartSnapshotLine[]): string[] {
  if (!evalCase.dish) return [];
  return evalCase.dish.core
    .filter((group) => !cart.some((line) => group.options.includes(line.key)))
    .map((group) => `missing ${group.label}`);
}

function servingsMisses(input: ScoreInput): string[] {
  if (!input.evalCase.dish?.askServings) return [];
  const firstReply = input.savedTexts.filter((block) => block.turn === 1).map((block) => block.text).join("\n").toLowerCase();
  return SERVINGS_TERMS.some((term) => firstReply.includes(term)) ? [] : ["servings not asked"];
}

function assignGroups(cart: CartSnapshotLine[], evalCase: EvalCase, binding: CatalogBinding): { satisfied: number; acceptable: number; safety: string[] } {
  const used = new Set<number>();
  let satisfied = 0;
  const safety: string[] = [];
  for (const group of evalCase.mustHave) {
    const index = cart.findIndex((line, lineIndex) => !used.has(lineIndex) && group.options.some((option) => lineMatches(line, option, evalCase)));
    if (index >= 0) {
      used.add(index);
      satisfied += 1;
    }
  }
  let acceptable = 0;
  for (let index = 0; index < cart.length; index += 1) {
    const line = cart[index];
    if (!line) continue;
    const may = evalCase.mayHave.some((option) => lineMatches(line, option, { ...evalCase, qty: [] }));
    if (used.has(index) || may) acceptable += 1;
    const required = evalCase.mustHave.some((group) => group.options.some((option) => option.listingKey === line.key));
    if (required && !used.has(index)) {
      const variantOk = evalCase.mustHave.some((group) => group.options.some((option) => option.listingKey === line.key && option.variantKeys.includes(line.variantKey)));
      if (!variantOk) safety.push("wrong-pack");
      else safety.push("wrong-quantity");
    }
    const listing = binding.byListingKey.get(line.key);
    if (listing && mayBeUnavailable(listing) && !["store_suggests", "named_substitute"].includes(line.swapRule) && evalCase.swapRule?.listingKey !== line.key) {
      safety.push("invalid-swap");
    }
  }
  return { satisfied, acceptable, safety };
}

function lineMatches(line: CartSnapshotLine, option: PackRef, evalCase: Pick<EvalCase, "qty">): boolean {
  if (line.key !== option.listingKey || !option.variantKeys.includes(line.variantKey)) return false;
  const rules = evalCase.qty ?? [];
  if (rules.length === 0) return true;
  const qty = rules.find((rule) => rule.listingKey === line.key && rule.variantKey === line.variantKey);
  if (!qty) return false;
  return line.qty >= qty.min && line.qty <= qty.max;
}

function mayBeUnavailable(listing: { confidence: number; stockMode: string; qty: number | null; status: string | null }): boolean {
  const hardZero = (listing.stockMode === "counted" && listing.qty === 0) || (listing.stockMode === "status" && listing.status === "out_of_stock");
  return listing.confidence < 0.6 || hardZero;
}

function prematureWrites(input: ScoreInput): string[] {
  const from = input.evalCase.addsFromTurn;
  if (from == null) return [];
  return input.successfulWriteTurns.some((turn) => turn < from) ? ["premature-write"] : [];
}

function swapFailures(input: ScoreInput, binding: CatalogBinding): string[] {
  const rule = input.evalCase.swapRule;
  if (!rule) return [];
  const failures: string[] = [];
  for (const line of input.cart) {
    if (line.key !== rule.listingKey) continue;
    if (!rule.allowed.includes(line.swapRule as SwapRuleName)) failures.push("invalid-swap");
    if (rule.substituteVariantKey) {
      const expected = binding.byVariantKey.get(rule.substituteVariantKey);
      if (!expected || line.swapRule !== "named_substitute" || line.substituteVariantKey !== rule.substituteVariantKey) {
        failures.push("wrong-substitute");
      }
    }
  }
  return failures;
}

function gapsAreReported(evalCase: EvalCase, cart: CartSnapshotLine[], replies: string[]): boolean {
  if (evalCase.gaps.length === 0) return true;
  const text = replies.join("\n").toLowerCase();
  return evalCase.gaps.every((gap) => {
    const inCart = gap.key ? cart.some((line) => line.key === gap.key) : false;
    const mentioned = gap.mention.some((term) => text.includes(term.toLowerCase()));
    return !inCart && mentioned;
  });
}

/**
 * Owner rule (2026-11-11): a made-up id is harm only when it reaches the cart or a reply to the shopper.
 * One a tool refused, never shown and never in the cart, is a rejected attempt. Cross-store ids are always harm.
 */
function collectHallucinations(input: ScoreInput, binding: CatalogBinding): { hallucinated: HallucinatedItem[]; rejectedAttempts: HallucinatedItem[] } {
  const found: HallucinatedItem[] = [];
  const rejected: HallucinatedItem[] = [];
  const seen = new Set<string>();
  const rejectedSeen = new Set<string>();
  const shown = input.savedTexts.map((block) => block.text).join("\n");
  const inCart = new Set(input.cart.map((line) => line.variantKey));
  const returned = new Set(input.returnedLineIds);
  const ownLines = new Set(input.cartLineIds);
  const packs = new Map<string, number>();
  for (const variant of binding.byVariantId.values()) packs.set(variant.listingId, (packs.get(variant.listingId) ?? 0) + 1);
  const singlePack = new Set([...binding.aListingIds].filter((id) => packs.get(id) === 1));
  for (const tool of input.tools) {
    walkIds(tool.input, (field, id) => {
      const item = classifyId(field, id, binding, returned, ownLines, tool.tool, singlePack);
      if (item && !item.crossStore && toolRefused(tool, id) && !inCart.has(id) && !shown.includes(id)) {
        pushItem(rejected, rejectedSeen, item);
        return;
      }
      pushItem(found, seen, item);
    });
    walkIds(tool.output, (field, id) => {
      if (!binding.bListingIds.has(id) && !binding.bVariantIds.has(id)) return;
      pushItem(found, seen, { tool: tool.tool, field, id, crossStore: true });
    });
    if (outputCode(tool.output) === "audit_failed") {
      walkIds(tool.input, (field, id) => {
        const item = classifyId(field, id, binding, returned, ownLines, tool.tool, singlePack);
        pushItem(found, seen, item);
      });
    }
  }
  for (const line of input.cart) {
    const variant = binding.byVariantKey.get(line.variantKey);
    if (!variant || variant.store !== "A") {
      pushItem(found, seen, { tool: "cart", field: "variant_id", id: line.variantKey, crossStore: variant?.store === "B" });
    }
  }
  return { hallucinated: found, rejectedAttempts: rejected.filter((item) => !seen.has(`${item.id}:${item.crossStore}`)) };
}

/** True when the tool did not act on this id: the call failed, the id is in notFound, or its add_to_cart item failed. */
function toolRefused(tool: ObservedTool, id: string): boolean {
  if (tool.errored) return true;
  const output = tool.output;
  if (!output || typeof output !== "object") return false;
  const record = output as { ok?: unknown; code?: unknown; error?: unknown; notFound?: unknown; items?: unknown };
  if (record.code === "audit_failed") return false;
  if (record.ok === false || (record.ok === undefined && record.error != null && record.error !== false)) return true;
  if (Array.isArray(record.notFound) && record.notFound.includes(id)) return true;
  if (tool.tool !== "add_to_cart" || !Array.isArray(record.items)) return false;
  const inputs = (tool.input as { items?: unknown } | null)?.items;
  if (!Array.isArray(inputs)) return false;
  const results = record.items as Array<{ ok?: unknown } | null>;
  const uses = inputs.map((item, index) => ({ hit: JSON.stringify(item).includes(JSON.stringify(id)), failed: results[index]?.ok === false }));
  return uses.some((use) => use.hit) && uses.every((use) => !use.hit || use.failed);
}

function pushItem(found: HallucinatedItem[], seen: Set<string>, item: HallucinatedItem | null): void {
  if (!item) return;
  // One invented id is one item, even when a tool output echoes it under other fields.
  const key = `${item.id}:${item.crossStore}`;
  if (seen.has(key)) return;
  seen.add(key);
  found.push(item);
}

function classifyId(
  field: string,
  id: string,
  binding: CatalogBinding,
  returnedLines: Set<string>,
  ownLines: Set<string>,
  tool: string,
  singlePack: Set<string>,
): HallucinatedItem | null {
  const cross = binding.bListingIds.has(id) || binding.bVariantIds.has(id);
  if (LISTING_FIELDS.has(field)) {
    if (binding.aListingIds.has(id)) return null;
    if (binding.aVariantIds.has(id) || cross || !binding.aListingIds.has(id)) {
      return { tool, field, id, crossStore: cross };
    }
  }
  if (VARIANT_FIELDS.has(field)) {
    if (binding.aVariantIds.has(id)) return null;
    // add_to_cart resolves a listing id with exactly one variant to that variant.
    if (tool === "add_to_cart" && singlePack.has(id)) return null;
    return { tool, field, id, crossStore: cross };
  }
  if (LINE_FIELDS.has(field)) {
    if (returnedLines.has(id) || ownLines.has(id)) return null;
    return { tool, field, id, crossStore: false };
  }
  return null;
}

function walkIds(value: unknown, visit: (field: string, id: string) => void, field = ""): void {
  if (typeof value === "string" && field) visit(field, value);
  if (Array.isArray(value)) {
    if (field === "listing_ids") {
      for (const item of value) if (typeof item === "string") visit("listing_ids", item);
      return;
    }
    for (const item of value) walkIds(item, visit, field);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "_turn" || key === "_call") continue;
    walkIds(child, visit, key);
  }
}

function outputCode(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const code = (output as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

interface Allowance {
  keyed: Map<string, number>;
  thisTurnCents: Set<number>;
}

function disallowedAmounts(block: TextBlock, input: ScoreInput, binding: CatalogBinding): number[] {
  const foreign = hasForeignCurrency(block.text) ? [-1] : [];
  const allowed = allowanceFor(block, input);
  return [
    ...foreign,
    ...usdAmountsInText(block.text).filter((cents) => {
      if (cents === binding.minimumOrderCents) return false;
      if (allowed.thisTurnCents.has(cents)) return false;
      for (const price of allowed.keyed.values()) if (price === cents) return false;
      return true;
    }),
  ];
}

function allowanceFor(block: TextBlock, input: ScoreInput): Allowance {
  const keyed = new Map<string, number>();
  const thisTurnCents = new Set<number>();
  const outputs: Array<{ turn: number; output: unknown }> = [];
  for (const tool of input.tools) {
    if (tool.turn < block.turn) outputs.push({ turn: tool.turn, output: tool.output });
    if (tool.turn === block.turn && block.priorOutputs.includes(tool.output)) {
      outputs.push({ turn: tool.turn, output: tool.output });
    }
  }
  for (const extra of block.priorOutputs) {
    if (!outputs.some((item) => item.output === extra)) outputs.push({ turn: block.turn, output: extra });
  }
  for (const item of outputs) {
    collectKeyed(item.output, keyed);
    if (item.turn === block.turn) collectCents(item.output, thisTurnCents);
  }
  return { keyed, thisTurnCents };
}

function collectKeyed(value: unknown, into: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeyed(item, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const variantId = record.variantId;
  const listingId = record.listingId;
  const key = typeof variantId === "string" && variantId ? `variant:${variantId}` : variantId == null && typeof listingId === "string" ? `listing:${listingId}` : null;
  if (key) {
    for (const field of ["priceCents", "unitPriceCents"]) {
      const cents = record[field];
      if (typeof cents === "number" && Number.isInteger(cents)) into.set(key, cents);
    }
  }
  for (const child of Object.values(record)) collectKeyed(child, into);
}

function collectCents(value: unknown, into: Set<number>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCents(item, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith("Cents") && typeof child === "number" && Number.isInteger(child)) into.add(child);
    collectCents(child, into);
  }
}

export function bindingFromFixture(fixture: CatalogFixture, ids: Map<string, { listingId: string; variants: Map<string, string> }>): CatalogBinding {
  const byListingKey = new Map<string, CatalogBinding["byListingKey"] extends Map<string, infer V> ? V : never>();
  const byVariantKey = new Map<string, BoundVariant>();
  const byListingId = new Map<string, string>();
  const byVariantId = new Map<string, BoundVariant>();
  const aListingIds = new Set<string>();
  const aVariantIds = new Set<string>();
  const bListingIds = new Set<string>();
  const bVariantIds = new Set<string>();
  for (const listing of fixture.listings) {
    const created = ids.get(listing.key);
    if (!created) continue;
    byListingKey.set(listing.key, {
      id: created.listingId,
      key: listing.key,
      store: listing.store,
      confidence: listing.confidence,
      stockMode: listing.stockMode,
      qty: listing.qty,
      status: listing.status,
      active: listing.active,
    });
    byListingId.set(created.listingId, listing.key);
    if (listing.store === "A") aListingIds.add(created.listingId);
    else bListingIds.add(created.listingId);
    for (const variant of listing.variants) {
      const variantId = created.variants.get(variant.key);
      if (!variantId) continue;
      const bound: BoundVariant = {
        id: variantId,
        key: variant.key,
        listingKey: listing.key,
        listingId: created.listingId,
        store: listing.store,
        priceCents: variant.priceCents,
      };
      byVariantKey.set(variant.key, bound);
      byVariantId.set(variantId, bound);
      if (listing.store === "A") aVariantIds.add(variantId);
      else bVariantIds.add(variantId);
    }
  }
  return {
    byListingKey,
    byVariantKey,
    byListingId,
    byVariantId,
    aListingIds,
    aVariantIds,
    bListingIds,
    bVariantIds,
    minimumOrderCents: fixture.store.minimumOrderCents,
  };
}

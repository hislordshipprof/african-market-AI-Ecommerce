"use server";

import { z } from "zod";
import { AssistantConfigError } from "../assistant/errors";
import { assistantSpendState } from "../assistant/spend";
import { judgeDuplicatePairs, type DuplicateVerdict, type JudgedProduct, type PairToJudge } from "../catalog/duplicate-judge";
import {
  Prisma,
  copyMasterProductIngredients,
  duplicateCandidates,
  listingCountsByStore,
  lockDuplicateScan,
  lockMasterProductRow,
  platformAdminTransaction,
  replaceOpenDuplicatePairs,
  repointListings,
  repointPendingListingDrafts,
  repointRecipeIngredients,
  storesListingMasterProduct,
  writeDuplicateVerdicts,
} from "../db";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { requirePlatformAdmin } from "./session";

/** Pairs one scan keeps, best first. */
const DUPLICATE_PAIRS_MAX = 200;
/** Pairs Claude judges per scan: the best this many. */
const JUDGE_TOP = 50;
const JUDGE_BATCH = 10;
/** A pair qualifies on this name similarity, or on one shared name or synonym. */
const NAME_SIMILARITY_MIN = 0.4;
const WRITE_TRANSACTION = { timeout: 30_000, maxWait: 10_000 };

type Tx = Parameters<Parameters<typeof platformAdminTransaction>[0]>[0];

export type ScanResult = { found: number; judged: number; unjudged: number; resting: boolean; judgeFailed: boolean };

/**
 * The on-demand duplicate scan. Candidate pairs share a category and either have similar names
 * (trigram similarity, ADR-0022) or a name or synonym in common, compared whole and case-folded.
 * A pair the admin dismissed or merged is never proposed again. Then Claude judges the best pairs
 * that have no verdict yet, inside the AI spend cap; a resting cap leaves them unjudged.
 */
export async function scanCatalogDuplicates(): Promise<ScanResult> {
  await requirePlatformAdmin();
  const found = await platformAdminTransaction(async (tx) => {
    // One scan at a time; a second waits and then rebuilds the same list.
    await lockDuplicateScan(tx);
    const candidates = await duplicateCandidates(tx, NAME_SIMILARITY_MIN, DUPLICATE_PAIRS_MAX);
    await replaceOpenDuplicatePairs(tx, candidates);
    return candidates.length;
  }, WRITE_TRANSACTION);

  const judging = await judgeTopPairs();
  return { found, ...judging };
}

type ProductFacts = JudgedProduct & { id: string };

async function productFacts(tx: Tx, ids: string[]): Promise<Map<string, ProductFacts>> {
  const products = await tx.masterProduct.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, name: true, subcategory: true, unit: true, weightG: true, description: true,
      category: { select: { name: true } },
      synonyms: { select: { term: true }, orderBy: { term: "asc" } },
    },
  });
  return new Map(products.map((product) => [product.id, {
    id: product.id,
    name: product.name,
    category: product.category?.name ?? null,
    subcategory: product.subcategory,
    unit: product.unit,
    weightG: product.weightG,
    description: product.description,
    synonyms: product.synonyms.map((synonym) => synonym.term),
  }]));
}

/** Verdicts are written batch by batch, so a run that dies keeps what it judged and the next scan judges the rest. */
async function judgeTopPairs(): Promise<Omit<ScanResult, "found">> {
  const pending = await platformAdminTransaction(async (tx) => {
    const top = await tx.catalogDuplicatePair.findMany({
      where: { status: "open" },
      orderBy: [{ score: "desc" }, { productAId: "asc" }, { productBId: "asc" }],
      take: JUDGE_TOP,
      select: { id: true, productAId: true, productBId: true, verdict: true },
    });
    const unjudged = top.filter((pair) => pair.verdict === null);
    const facts = await productFacts(tx, unjudged.flatMap((pair) => [pair.productAId, pair.productBId]));
    return unjudged.flatMap((pair): PairToJudge[] => {
      const a = facts.get(pair.productAId);
      const b = facts.get(pair.productBId);
      return a && b ? [{ id: pair.id, a, b }] : [];
    });
  });

  let judged = 0;
  let resting = false;
  let judgeFailed = false;
  for (let start = 0; start < pending.length; start += JUDGE_BATCH) {
    if ((await assistantSpendState()).resting) {
      resting = true;
      break;
    }
    const batch = pending.slice(start, start + JUDGE_BATCH);
    let verdicts: Map<string, { verdict: DuplicateVerdict; reason: string }>;
    try {
      verdicts = await judgeDuplicatePairs(batch);
    } catch (error) {
      judgeFailed = true;
      console.error("[catalog] duplicate judging failed", error instanceof AssistantConfigError ? "config" : error instanceof Error ? error.name : "unknown");
      break;
    }
    if (verdicts.size === 0) continue;
    await platformAdminTransaction((tx) => writeDuplicateVerdicts(tx, [...verdicts].map(([id, value]) => ({ id, ...value }))));
    judged += verdicts.size;
  }
  return { judged, unjudged: pending.length - judged, resting, judgeFailed };
}

export type PairProduct = {
  id: string;
  name: string;
  status: string;
  imageUrl: string | null;
  categoryName: string | null;
  subcategory: string | null;
  unit: string | null;
  weightG: number | null;
  synonyms: string[];
  /** Listings per store, by store name. */
  stores: Array<{ storeId: string; storeName: string; listings: number }>;
  ingredients: { status: string; names: string[] };
  allergens: { status: string; values: string[] };
  dietary: { status: string; values: string[] };
};

export type DuplicatePairView = {
  id: string;
  score: number;
  nameSimilarity: number;
  sharedTerms: number;
  verdict: DuplicateVerdict | null;
  verdictReason: string | null;
  a: PairProduct;
  b: PairProduct;
};

/** Open pairs, best first, each product with what the admin needs to choose. */
export async function listDuplicatePairs(): Promise<DuplicatePairView[]> {
  await requirePlatformAdmin();
  return platformAdminTransaction(async (tx) => {
    const pairs = await tx.catalogDuplicatePair.findMany({
      where: { status: "open" },
      orderBy: [{ score: "desc" }, { productAId: "asc" }, { productBId: "asc" }],
      take: DUPLICATE_PAIRS_MAX,
    });
    const ids = [...new Set(pairs.flatMap((pair) => [pair.productAId, pair.productBId]))];
    if (ids.length === 0) return [];
    const products = await tx.masterProduct.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, name: true, status: true, imageUrl: true, subcategory: true, unit: true, weightG: true,
        ingredientsStatus: true, allergens: true, allergensStatus: true, dietaryClaims: true, dietaryStatus: true,
        category: { select: { name: true } },
        synonyms: { select: { term: true }, orderBy: { term: "asc" } },
        ingredients: { select: { ingredient: { select: { name: true } } } },
      },
    });
    const stores = await listingCountsByStore(tx, ids);
    const byId = new Map(products.map((product): [string, PairProduct] => [product.id, {
      id: product.id,
      name: product.name,
      status: product.status,
      imageUrl: product.imageUrl,
      categoryName: product.category?.name ?? null,
      subcategory: product.subcategory,
      unit: product.unit,
      weightG: product.weightG,
      synonyms: product.synonyms.map((synonym) => synonym.term),
      stores: stores
        .filter((row) => row.product_id === product.id)
        .map((row) => ({ storeId: row.store_id, storeName: row.store_name, listings: row.listings })),
      ingredients: { status: product.ingredientsStatus, names: product.ingredients.map((link) => link.ingredient.name).sort() },
      allergens: { status: product.allergensStatus, values: [...product.allergens].sort() },
      dietary: { status: product.dietaryStatus, values: [...product.dietaryClaims].sort() },
    }]));
    return pairs.flatMap((pair): DuplicatePairView[] => {
      const a = byId.get(pair.productAId);
      const b = byId.get(pair.productBId);
      if (!a || !b) return [];
      return [{
        id: pair.id,
        score: pair.score,
        nameSimilarity: pair.nameSimilarity,
        sharedTerms: pair.sharedTerms,
        verdict: pair.verdict as DuplicateVerdict | null,
        verdictReason: pair.verdictReason,
        a,
        b,
      }];
    });
  });
}

export type DuplicateActionState = { ok?: boolean; message?: string };

const PAIR_GONE = "This pair was already handled. Reload the page.";
const idSchema = z.string().min(1).max(200);

/** "Not a duplicate": the pair is remembered and never proposed again. */
export async function dismissDuplicatePair(_prev: DuplicateActionState, form: FormData): Promise<DuplicateActionState> {
  const session = await requirePlatformAdmin();
  const pairId = parseInput(idSchema, form.get("pairId"));
  if (!pairId.ok) return { ok: false, message: PAIR_GONE };
  return platformAdminTransaction(async (tx) => {
    const updated = await tx.catalogDuplicatePair.updateMany({
      where: { id: pairId.data, status: "open" },
      data: { status: "dismissed", decidedById: session.user.id, decidedAt: new Date() },
    });
    if (updated.count === 0) return { ok: false, message: PAIR_GONE };
    const pair = await tx.catalogDuplicatePair.findUniqueOrThrow({ where: { id: pairId.data } });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.duplicate_dismiss",
        entityType: "catalog_duplicate_pair",
        entityId: pair.id,
        after: { productAId: pair.productAId, productBId: pair.productBId, verdict: pair.verdict },
      },
    });
    return { ok: true, message: "Marked as not a duplicate" };
  });
}

type GroupName = "ingredients" | "allergens" | "dietary";
const GROUP_LABELS: Record<GroupName, string> = { ingredients: "ingredients", allergens: "allergens", dietary: "dietary claims" };

type AttributeSnapshot = {
  ingredientsStatus: string;
  ingredientIds: string[];
  allergensStatus: string;
  allergens: string[];
  dietaryStatus: string;
  dietaryClaims: string[];
};

function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function groupOf(snapshot: AttributeSnapshot, group: GroupName): { status: string; values: string[] } {
  if (group === "ingredients") return { status: snapshot.ingredientsStatus, values: snapshot.ingredientIds };
  if (group === "allergens") return { status: snapshot.allergensStatus, values: snapshot.allergens };
  return { status: snapshot.dietaryStatus, values: snapshot.dietaryClaims };
}

const mergeSchema = z.strictObject({ pairId: idSchema, survivorId: idSchema });

/**
 * Merges the pair into the survivor in one transaction: listings, synonyms (no repeats), recipe
 * ingredients, pending shelf-photo drafts and ingredient links move to the survivor, the loser's
 * pending attribute proposals are superseded, and the loser becomes "merged". No listing is deleted:
 * a store that lists both keeps both. Refused while both products have a reviewed attribute group
 * and the two disagree.
 */
export async function mergeDuplicatePair(_prev: DuplicateActionState, form: FormData): Promise<DuplicateActionState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(mergeSchema, { pairId: form.get("pairId"), survivorId: form.get("survivorId") });
  if (!parsed.ok) return { ok: false, message: "Choose which product to keep." };
  const { pairId, survivorId } = parsed.data;

  const preview = await platformAdminTransaction((tx) => tx.catalogDuplicatePair.findUnique({ where: { id: pairId } }));
  if (!preview || preview.status !== "open") return { ok: false, message: PAIR_GONE };
  if (survivorId !== preview.productAId && survivorId !== preview.productBId) return { ok: false, message: "Choose which product to keep." };

  const result = await platformAdminTransaction(async (tx): Promise<DuplicateActionState & { storeIds?: string[] }> => {
    // Locked in id order (A < B), the same order every merge uses.
    await lockMasterProductRow(tx, preview.productAId);
    await lockMasterProductRow(tx, preview.productBId);
    const pair = await tx.catalogDuplicatePair.findUnique({ where: { id: pairId } });
    if (!pair || pair.status !== "open") return { ok: false, message: PAIR_GONE };
    const loserId = survivorId === pair.productAId ? pair.productBId : pair.productAId;

    const products = await tx.masterProduct.findMany({
      where: { id: { in: [survivorId, loserId] } },
      include: { ingredients: { select: { ingredientId: true } } },
    });
    const survivor = products.find((product) => product.id === survivorId);
    const loser = products.find((product) => product.id === loserId);
    if (!survivor || !loser) return { ok: false, message: PAIR_GONE };
    for (const product of [survivor, loser]) {
      if (product.status !== "active" && product.status !== "needs_review") {
        return { ok: false, message: `${product.name} is ${product.status.replace("_", " ")} now, so it cannot be merged. Reload the page.` };
      }
    }

    const snapshot = (product: typeof survivor): AttributeSnapshot => ({
      ingredientsStatus: product.ingredientsStatus,
      ingredientIds: product.ingredients.map((link) => link.ingredientId).sort(),
      allergensStatus: product.allergensStatus,
      allergens: [...product.allergens].sort(),
      dietaryStatus: product.dietaryStatus,
      dietaryClaims: [...product.dietaryClaims].sort(),
    });
    const kept = snapshot(survivor);
    const merged = snapshot(loser);
    const groups: GroupName[] = ["ingredients", "allergens", "dietary"];
    const conflicts = groups.filter((group) => {
      const a = groupOf(kept, group);
      const b = groupOf(merged, group);
      return a.status === "reviewed" && b.status === "reviewed" && !sameSet(a.values, b.values);
    });
    if (conflicts.length > 0) {
      return {
        ok: false,
        message: `Both products have reviewed ${conflicts.map((group) => GROUP_LABELS[group]).join(" and ")} that disagree. Correct one of them in the attribute review, then merge.`,
      };
    }

    // The survivor takes a reviewed group it lacks, so a merge never drops reviewed allergen data.
    const attributeData: Prisma.MasterProductUpdateInput = {};
    const adopted: GroupName[] = [];
    if (kept.ingredientsStatus !== "reviewed" && merged.ingredientsStatus === "reviewed") {
      await tx.masterProductIngredient.deleteMany({ where: { productId: survivorId } });
      attributeData.ingredientsStatus = "reviewed";
      adopted.push("ingredients");
    }
    if (kept.ingredientsStatus !== "reviewed") {
      await copyMasterProductIngredients(tx, loserId, survivorId);
    }
    await tx.masterProductIngredient.deleteMany({ where: { productId: loserId } });
    if (kept.allergensStatus !== "reviewed" && merged.allergensStatus === "reviewed") {
      attributeData.allergens = merged.allergens;
      attributeData.allergensStatus = "reviewed";
      adopted.push("allergens");
    }
    if (kept.dietaryStatus !== "reviewed" && merged.dietaryStatus === "reviewed") {
      attributeData.dietaryClaims = merged.dietaryClaims;
      attributeData.dietaryStatus = "reviewed";
      adopted.push("dietary");
    }
    if (Object.keys(attributeData).length > 0) await tx.masterProduct.update({ where: { id: survivorId }, data: attributeData });

    const listings = await repointListings(tx, loserId, survivorId);

    // Synonyms: the loser's name and terms the survivor lacks move over; repeats are dropped.
    const survivorSynonyms = await tx.productSynonym.findMany({ where: { productId: survivorId }, select: { term: true } });
    const known = new Set([survivor.name, ...survivorSynonyms.map((synonym) => synonym.term)].map((term) => term.trim().toLowerCase()));
    const loserSynonyms = await tx.productSynonym.findMany({ where: { productId: loserId }, orderBy: { createdAt: "asc" } });
    const movedSynonyms: string[] = [];
    const droppedSynonyms: string[] = [];
    for (const synonym of loserSynonyms) {
      const key = synonym.term.trim().toLowerCase();
      if (known.has(key)) {
        droppedSynonyms.push(synonym.term);
        await tx.productSynonym.delete({ where: { id: synonym.id } });
      } else {
        known.add(key);
        movedSynonyms.push(synonym.term);
        await tx.productSynonym.update({ where: { id: synonym.id }, data: { productId: survivorId } });
      }
    }
    const loserName = loser.name.trim().toLowerCase();
    const addedName = !known.has(loserName);
    if (addedName) await tx.productSynonym.create({ data: { productId: survivorId, term: loser.name } });

    const recipeIngredients = await repointRecipeIngredients(tx, loserId, survivorId);
    const drafts = await repointPendingListingDrafts(tx, loserId, survivorId);
    const superseded = await tx.attributeProposal.updateMany({
      where: { productId: loserId, status: "pending" },
      data: { status: "superseded", reviewedAt: new Date(), reviewedBy: session.user.id },
    });

    await tx.masterProduct.updateMany({ where: { mergedIntoId: loserId }, data: { mergedIntoId: survivorId } });
    await tx.masterProduct.update({ where: { id: loserId }, data: { status: "merged", mergedIntoId: survivorId } });
    await tx.catalogDuplicatePair.update({
      where: { id: pair.id },
      data: { status: "merged", decidedById: session.user.id, decidedAt: new Date() },
    });
    // Other open pairs with the loser point at a product that is gone; the next scan proposes the survivor instead.
    await tx.catalogDuplicatePair.deleteMany({
      where: { status: "open", OR: [{ productAId: loserId }, { productBId: loserId }] },
    });

    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.product_merge",
        entityType: "master_product",
        entityId: survivorId,
        before: {
          pairId: pair.id,
          verdict: pair.verdict,
          survivor: { id: survivor.id, name: survivor.name, status: survivor.status, ...kept },
          loser: { id: loser.id, name: loser.name, status: loser.status, ...merged },
        },
        after: {
          loserId,
          loserStatus: "merged",
          listingIds: listings.map((listing) => listing.id).sort(),
          movedSynonyms,
          droppedSynonyms,
          addedSynonym: addedName ? loser.name : null,
          recipeIngredientIds: recipeIngredients.map((row) => row.id),
          draftIds: drafts.map((row) => row.id),
          supersededProposals: superseded.count,
          adoptedGroups: adopted,
        } as Prisma.InputJsonObject,
      },
    });

    const storeIds = await storesListingMasterProduct(tx, survivorId);
    return {
      ok: true,
      message: `Merged ${loser.name} into ${survivor.name}. ${listings.length} listing${listings.length === 1 ? "" : "s"} moved.`,
      storeIds,
    };
  }, WRITE_TRANSACTION);

  const { storeIds, ...state } = result;
  for (const storeId of storeIds ?? []) revalidateStorefront(storeId);
  return state;
}

export type ScanState = { ok?: boolean; message?: string };

/** The page's "Find duplicates" button. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a form action takes these
export async function runDuplicateScan(_prev: ScanState, _form: FormData): Promise<ScanState> {
  await requirePlatformAdmin();
  const result = await scanCatalogDuplicates();
  const found = `${result.found} possible ${result.found === 1 ? "duplicate" : "duplicates"} found.`;
  if (result.resting) return { ok: true, message: `${found} The AI spend limit is reached for today, so ${result.unjudged} ${result.unjudged === 1 ? "pair is" : "pairs are"} not judged yet.` };
  if (result.judgeFailed) return { ok: true, message: `${found} Claude could not judge them right now; ${result.unjudged} ${result.unjudged === 1 ? "pair is" : "pairs are"} not judged yet.` };
  return { ok: true, message: `${found} Claude judged ${result.judged} new ${result.judged === 1 ? "pair" : "pairs"}.` };
}

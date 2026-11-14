import { Prisma } from "@prisma/client";
import { lockConversationRow, storeScoped, storeScopedRawQuery, storeScopedTransaction } from "../db";
import { checkNeed, type Allergen, type DietaryClaim, type ProductAttributes, type ShopperNeed } from "../catalog/attributes";
import { attributesFromRow, effectiveAttributesSql, needExcludesSql, type AttributeRow } from "../catalog/attribute-sql";
import { resolveIngredients } from "../catalog/ingredients";

/** What the customer said to avoid or require, saved on the conversation, never taken from a search call. */
export interface ShopperConstraints {
  avoidAllergens: Allergen[];
  requireClaims: DietaryClaim[];
  avoidIngredients: Array<{ term: string; ingredientId: string }>;
  /** One form of a known ingredient the customer would rather skip, such as fresh tomato. It gates nothing. */
  preferences: string[];
  /** Listings refused as unknown, by the user message whose turn refused them. */
  asked: Record<string, string>;
  /** Unknown listings the customer confirmed, one at a time, with the constraint keys unknown at that time. */
  confirmed: Array<{ listingId: string; messageId: string; at: string; needs: string[] }>;
  /** The most the customer wants the cart's items to cost. A limit, not a need: it never changes a swap. */
  budgetCents?: number;
}

export type ConstraintStatus = "ok" | "excluded" | "unknown";

const EMPTY: ShopperConstraints = { avoidAllergens: [], requireClaims: [], avoidIngredients: [], preferences: [], asked: {}, confirmed: [] };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseConstraints(raw: unknown): ShopperConstraints {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return structuredClone(EMPTY);
  const record = raw as Record<string, unknown>;
  const ingredients = Array.isArray(record.avoidIngredients) ? record.avoidIngredients : [];
  const asked = record.asked && typeof record.asked === "object" && !Array.isArray(record.asked)
    ? Object.fromEntries(Object.entries(record.asked).filter(([, id]) => typeof id === "string")) as Record<string, string>
    : {};
  return {
    avoidAllergens: strings(record.avoidAllergens) as Allergen[],
    requireClaims: strings(record.requireClaims) as DietaryClaim[],
    avoidIngredients: ingredients.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as { term?: unknown; ingredientId?: unknown };
      if (typeof row.term !== "string" || typeof row.ingredientId !== "string") return [];
      return [{ term: row.term, ingredientId: row.ingredientId }];
    }),
    preferences: strings(record.preferences),
    asked,
    confirmed: Array.isArray(record.confirmed)
      ? record.confirmed.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        if (typeof row.listingId !== "string" || typeof row.messageId !== "string" || typeof row.at !== "string") return [];
        return [{ listingId: row.listingId, messageId: row.messageId, at: row.at, needs: strings(row.needs) }];
      })
      : [],
    ...(typeof record.budgetCents === "number" && Number.isInteger(record.budgetCents) && record.budgetCents > 0
      ? { budgetCents: record.budgetCents }
      : {}),
  };
}

export function hasConstraints(constraints: ShopperConstraints): boolean {
  return Object.values(shopperNeed(constraints)).some((values) => values.length > 0);
}

export function shopperNeed(constraints: ShopperConstraints): ShopperNeed {
  return {
    avoidAllergens: constraints.avoidAllergens,
    requireClaims: constraints.requireClaims,
    avoidIngredientIds: constraints.avoidIngredients.map((item) => item.ingredientId),
  };
}

export async function readConstraints(storeId: string, conversationId: string): Promise<ShopperConstraints> {
  const row = await storeScoped(storeId).aiConversation.findUnique({
    where: { id: conversationId },
    select: { constraints: true },
  });
  return parseConstraints(row?.constraints);
}

type ScopedTx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

/** Changes the saved constraints under the conversation row lock. */
export async function updateConstraints(
  storeId: string,
  conversationId: string,
  change: (constraints: ShopperConstraints, tx: ScopedTx) => Promise<void> | void,
): Promise<ShopperConstraints> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockConversationRow(tx, conversationId);
    const row = await tx.aiConversation.findUnique({ where: { id: conversationId }, select: { constraints: true } });
    const constraints = parseConstraints(row?.constraints);
    await change(constraints, tx);
    await tx.aiConversation.update({
      where: { id: conversationId },
      data: { constraints: constraints as unknown as Prisma.InputJsonValue },
    });
    return constraints;
  });
}

/**
 * Known ingredients whose name or synonym the term contains, or that contain the term, with the catalog
 * search's English text match: "fresh tomato" finds tomato. They are only offered in a question, never enforced.
 */
async function closestIngredients(storeId: string, term: string): Promise<Array<{ id: string; name: string }>> {
  return storeScopedRawQuery<{ id: string; name: string }>(storeId, Prisma.sql`
    SELECT i.id, i.name FROM ingredients i
    WHERE EXISTS (
      SELECT 1 FROM (SELECT i.name AS known UNION ALL SELECT s.term FROM ingredient_synonyms s WHERE s.ingredient_id = i.id) k
      WHERE to_tsvector('english', unaccent(${term})) @@ plainto_tsquery('english', unaccent(k.known))
         OR to_tsvector('english', unaccent(k.known)) @@ plainto_tsquery('english', unaccent(${term}))
    )
    ORDER BY search_similarity(i.name, ${term}) DESC, i.name
    LIMIT 3
  `);
}

export interface ConstraintChange {
  constraints: ShopperConstraints;
  /** Terms that name no known ingredient but are close to one: the customer chooses all of it or only that form. */
  ask: Array<{ term: string; closest: string[] }>;
  /** Terms close to no known ingredient: this store's product data cannot check them. */
  cannotCheck: string[];
}

/**
 * Adds and removes constraints. An ingredient term that is a known name or synonym is a hard constraint.
 * A term only close to one is kept as a preference until the customer says it means all of it.
 */
export async function changeConstraints(
  storeId: string,
  conversationId: string,
  input: { avoidAllergens: Allergen[]; requireClaims: DietaryClaim[]; avoidIngredients: string[]; remove: string[]; budgetCents?: number },
): Promise<ConstraintChange> {
  const ask: ConstraintChange["ask"] = [];
  const unchecked: string[] = [];
  const known: Array<{ term: string; ingredientId: string }> = [];
  for (const term of [...new Set(input.avoidIngredients.map((raw) => raw.trim().toLowerCase()))]) {
    if (term === "") continue;
    const ingredientId = (await storeScopedTransaction(storeId, (tx) => resolveIngredients(tx, [term], { create: false }))).ids[0];
    if (ingredientId) {
      known.push({ term, ingredientId });
      continue;
    }
    const closest = await closestIngredients(storeId, term);
    if (closest.length > 0) ask.push({ term, closest: closest.map((row) => row.name) });
    else unchecked.push(term);
  }
  // A preference is answered once its closest ingredient is saved as a hard constraint.
  const answered = new Set<string>();
  if (known.length > 0) {
    const saved = await readConstraints(storeId, conversationId);
    for (const term of saved.preferences) {
      const closest = await closestIngredients(storeId, term);
      if (closest.some((row) => known.some((item) => item.ingredientId === row.id))) answered.add(term);
    }
  }
  const constraints = await updateConstraints(storeId, conversationId, (constraints) => {
    constraints.avoidAllergens = [...new Set([...constraints.avoidAllergens, ...input.avoidAllergens])];
    constraints.requireClaims = [...new Set([...constraints.requireClaims, ...input.requireClaims])];
    for (const item of known) {
      if (!constraints.avoidIngredients.some((kept) => kept.term === item.term)) constraints.avoidIngredients.push(item);
    }
    for (const { term } of ask) {
      if (!constraints.preferences.includes(term)) constraints.preferences.push(term);
    }
    const removed = new Set(input.remove.map((name) => name.trim().toLowerCase()));
    constraints.avoidAllergens = constraints.avoidAllergens.filter((name) => !removed.has(name));
    constraints.requireClaims = constraints.requireClaims.filter((name) => !removed.has(name));
    constraints.avoidIngredients = constraints.avoidIngredients.filter((item) => !removed.has(item.term));
    constraints.preferences = constraints.preferences.filter((term) => !removed.has(term) && !answered.has(term));
    if (input.budgetCents != null) constraints.budgetCents = input.budgetCents;
    if (removed.has("budget")) delete constraints.budgetCents;
  });
  return { constraints, ask, cannotCheck: unchecked };
}

/** A constraint by kind and value, so an allergen and an ingredient with the same name never share a status. */
export type NeedKey = `allergen:${string}` | `claim:${string}` | `ingredient:${string}`;

/** Each constraint by kind and value: checkNeed on one constraint at a time. */
export function constraintStatuses(attributes: ProductAttributes, constraints: ShopperConstraints): Record<NeedKey, ConstraintStatus> {
  const status = (need: ShopperNeed): ConstraintStatus => {
    const result = checkNeed(attributes, need);
    return result === "cannot_confirm" ? "unknown" : result;
  };
  const out: Record<NeedKey, ConstraintStatus> = {};
  for (const allergen of constraints.avoidAllergens) out[`allergen:${allergen}`] = status({ avoidAllergens: [allergen] });
  for (const claim of constraints.requireClaims) out[`claim:${claim}`] = status({ requireClaims: [claim] });
  for (const item of constraints.avoidIngredients) out[`ingredient:${item.ingredientId}`] = status({ avoidIngredientIds: [item.ingredientId] });
  return out;
}

export function overallStatus(statuses: Record<NeedKey, ConstraintStatus>): ConstraintStatus {
  const values = Object.values(statuses);
  if (values.includes("excluded")) return "excluded";
  return values.includes("unknown") ? "unknown" : "ok";
}

/** The one verdict for a listing: every tool output, card and gate reads it unchanged. */
export interface ListingVerdict {
  listingId: string;
  status: ConstraintStatus;
  needs: Record<NeedKey, ConstraintStatus>;
}

/** This store's listings checked against the constraints in SQL. A listing the store cannot see is left out. */
export async function listingVerdicts(
  storeId: string,
  listingIds: string[],
  constraints: ShopperConstraints,
): Promise<Map<string, ListingVerdict>> {
  const ids = [...new Set(listingIds)];
  if (ids.length === 0 || !hasConstraints(constraints)) {
    return new Map(ids.map((listingId) => [listingId, { listingId, status: "ok" as const, needs: {} }]));
  }
  const rows = await storeScopedRawQuery<AttributeRow & { id: string; excluded: boolean }>(storeId, Prisma.sql`
    SELECT l.id, attrs.*, ${needExcludesSql(shopperNeed(constraints))} AS excluded
    FROM listings l
    LEFT JOIN master_products mp ON l.master_product_id = mp.id
    ${effectiveAttributesSql}
    WHERE l.id IN (${Prisma.join(ids)})
  `);
  return new Map(rows.map((row) => {
    const needs = constraintStatuses(attributesFromRow(row), constraints);
    return [row.id, { listingId: row.id, status: row.excluded ? "excluded" : overallStatus(needs), needs }];
  }));
}

/** What a tool returns for a listing it shows: the verdict's needs, and cannotConfirm when it is unknown. */
export function verdictFields(verdict: ListingVerdict | undefined): { needs?: Record<NeedKey, ConstraintStatus>; cannotConfirm?: true } {
  if (!verdict) return {};
  return { needs: verdict.needs, ...(verdict.status === "unknown" ? { cannotConfirm: true as const } : {}) };
}

/** The constraint keys a listing cannot be confirmed for. */
export function unknownNeeds(verdict: ListingVerdict): NeedKey[] {
  return (Object.entries(verdict.needs) as Array<[NeedKey, ConstraintStatus]>).filter(([, value]) => value === "unknown").map(([key]) => key);
}

/** A constraint key in the customer's terms: the ingredient's saved term, else the value. */
function needName(key: NeedKey, constraints: ShopperConstraints): string {
  const value = key.slice(key.indexOf(":") + 1);
  if (!key.startsWith("ingredient:")) return value;
  return constraints.avoidIngredients.find((item) => item.ingredientId === value)?.term ?? value;
}

/** Why a listing is refused, in the customer's terms. */
export function verdictReason(verdict: ListingVerdict, constraints: ShopperConstraints): string {
  const names = (status: ConstraintStatus) => (Object.entries(verdict.needs) as Array<[NeedKey, ConstraintStatus]>)
    .filter(([, value]) => value === status).map(([key]) => needName(key, constraints));
  if (verdict.status === "excluded") return `It does not meet: ${names("excluded").join(", ")}.`;
  return `I can't confirm it meets: ${names("unknown").join(", ")}. Ask the customer about this item before adding it.`;
}

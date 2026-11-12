import { Prisma } from "@prisma/client";
import { lockConversationRow, storeScoped, storeScopedRawQuery, storeScopedTransaction } from "../db";
import { checkNeed, type Allergen, type DietaryClaim, type ProductAttributes, type ShopperNeed } from "../catalog/attributes";
import { attributesFromRow, effectiveAttributesSql, needExcludesSql, type AttributeRow } from "../catalog/attribute-sql";
import { resolveIngredients } from "../catalog/ingredients";

/** What the customer said to avoid or require, saved on the conversation, never taken from a search call. */
export interface ShopperConstraints {
  avoidAllergens: Allergen[];
  requireClaims: DietaryClaim[];
  /** An ingredient term with no known ingredient keeps a null id: nothing can be checked against it. */
  avoidIngredients: Array<{ term: string; ingredientId: string | null }>;
  /** Listings refused as unknown, by the user message whose turn refused them. */
  asked: Record<string, string>;
  /** Unknown listings the customer confirmed, one at a time. */
  confirmed: Array<{ listingId: string; messageId: string; at: string }>;
}

export type ConstraintStatus = "ok" | "excluded" | "unknown";

const EMPTY: ShopperConstraints = { avoidAllergens: [], requireClaims: [], avoidIngredients: [], asked: {}, confirmed: [] };

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
      if (typeof row.term !== "string") return [];
      return [{ term: row.term, ingredientId: typeof row.ingredientId === "string" ? row.ingredientId : null }];
    }),
    asked,
    confirmed: Array.isArray(record.confirmed) ? record.confirmed as ShopperConstraints["confirmed"] : [],
  };
}

export function hasConstraints(constraints: ShopperConstraints): boolean {
  return constraints.avoidAllergens.length + constraints.requireClaims.length + constraints.avoidIngredients.length > 0;
}

export function shopperNeed(constraints: ShopperConstraints): ShopperNeed {
  return {
    avoidAllergens: constraints.avoidAllergens,
    requireClaims: constraints.requireClaims,
    avoidIngredientIds: constraints.avoidIngredients.flatMap((item) => (item.ingredientId ? [item.ingredientId] : [])),
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

/** Adds and removes constraints. Ingredient terms resolve through the ingredient names and synonyms. */
export async function changeConstraints(
  storeId: string,
  conversationId: string,
  input: { avoidAllergens: Allergen[]; requireClaims: DietaryClaim[]; avoidIngredients: string[]; remove: string[] },
): Promise<ShopperConstraints> {
  return updateConstraints(storeId, conversationId, async (constraints, tx) => {
    const resolved = await Promise.all(input.avoidIngredients.map(async (term) => {
      const found = await resolveIngredients(tx, [term], { create: false });
      return { term: term.trim().toLowerCase(), ingredientId: found.ids[0] ?? null };
    }));
    constraints.avoidAllergens = [...new Set([...constraints.avoidAllergens, ...input.avoidAllergens])];
    constraints.requireClaims = [...new Set([...constraints.requireClaims, ...input.requireClaims])];
    for (const item of resolved) {
      if (item.term === "") continue;
      if (constraints.avoidIngredients.some((kept) => kept.term === item.term)) continue;
      constraints.avoidIngredients.push(item);
    }
    const removed = new Set(input.remove.map((name) => name.trim().toLowerCase()));
    constraints.avoidAllergens = constraints.avoidAllergens.filter((name) => !removed.has(name));
    constraints.requireClaims = constraints.requireClaims.filter((name) => !removed.has(name));
    constraints.avoidIngredients = constraints.avoidIngredients.filter((item) => !removed.has(item.term));
  });
}

/** Each constraint by name: checkNeed on one constraint at a time. An unresolved ingredient is always unknown. */
export function constraintStatuses(attributes: ProductAttributes, constraints: ShopperConstraints): Record<string, ConstraintStatus> {
  const status = (need: ShopperNeed): ConstraintStatus => {
    const result = checkNeed(attributes, need);
    return result === "cannot_confirm" ? "unknown" : result;
  };
  const out: Record<string, ConstraintStatus> = {};
  for (const allergen of constraints.avoidAllergens) out[allergen] = status({ avoidAllergens: [allergen] });
  for (const claim of constraints.requireClaims) out[claim] = status({ requireClaims: [claim] });
  for (const item of constraints.avoidIngredients) {
    out[item.term] = item.ingredientId ? status({ avoidIngredientIds: [item.ingredientId] }) : "unknown";
  }
  return out;
}

export function overallStatus(statuses: Record<string, ConstraintStatus>): ConstraintStatus {
  const values = Object.values(statuses);
  if (values.includes("excluded")) return "excluded";
  return values.includes("unknown") ? "unknown" : "ok";
}

export interface ListingVerdict {
  listingId: string;
  status: ConstraintStatus;
  needs: Record<string, ConstraintStatus>;
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

/** Why a listing is refused, in the customer's terms. */
export function verdictReason(verdict: ListingVerdict): string {
  const names = (status: ConstraintStatus) => Object.entries(verdict.needs).filter(([, value]) => value === status).map(([name]) => name);
  if (verdict.status === "excluded") return `It does not meet: ${names("excluded").join(", ")}.`;
  return `I can't confirm it meets: ${names("unknown").join(", ")}. Ask the customer about this item before adding it.`;
}

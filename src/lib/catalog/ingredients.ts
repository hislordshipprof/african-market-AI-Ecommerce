import type { PrismaClient } from "@prisma/client";

const NAME_MAX = 100;

/** One spelling per ingredient: trimmed, lower case, single spaces. */
export function normaliseIngredientName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, NAME_MAX);
}

type IngredientTx = Pick<PrismaClient, "ingredient" | "ingredientSynonym">;

/**
 * Names to ingredient ids, by canonical name or local-name synonym. With `create`
 * (platform admin only), a name that matches nothing becomes a new ingredient.
 */
export async function resolveIngredients(
  tx: IngredientTx,
  names: string[],
  opts: { create: boolean },
): Promise<{ ids: string[]; unmatched: string[] }> {
  const wanted = [...new Set(names.map(normaliseIngredientName).filter((name) => name !== ""))];
  const [byName, bySynonym] = await Promise.all([
    tx.ingredient.findMany({ where: { name: { in: wanted } }, select: { id: true, name: true } }),
    tx.ingredientSynonym.findMany({ where: { term: { in: wanted } }, select: { ingredientId: true, term: true } }),
  ]);
  const found = new Map<string, string>([
    ...bySynonym.map((s) => [s.term, s.ingredientId] as const),
    ...byName.map((i) => [i.name, i.id] as const),
  ]);
  const ids = new Set<string>();
  const unmatched: string[] = [];
  for (const name of wanted) {
    const id = found.get(name);
    if (id) ids.add(id);
    else if (opts.create) ids.add((await tx.ingredient.upsert({ where: { name }, create: { name }, update: {} })).id);
    else unmatched.push(name);
  }
  return { ids: [...ids], unmatched };
}

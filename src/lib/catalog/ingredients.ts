import type { PrismaClient } from "@prisma/client";
import { normaliseIngredientName } from "./attributes";

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
  const missing = wanted.filter((name) => !found.has(name));
  if (opts.create && missing.length > 0) {
    // Another approval may create the same ingredient at once: skip the duplicate, then read it by name.
    await tx.ingredient.createMany({ data: missing.map((name) => ({ name })), skipDuplicates: true });
    const created = await tx.ingredient.findMany({ where: { name: { in: missing } }, select: { id: true, name: true } });
    for (const ingredient of created) found.set(ingredient.name, ingredient.id);
  }
  const ids = new Set<string>();
  const unmatched: string[] = [];
  for (const name of wanted) {
    const id = found.get(name);
    if (id) ids.add(id);
    else unmatched.push(name);
  }
  return { ids: [...ids], unmatched };
}

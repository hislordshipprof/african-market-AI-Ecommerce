import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { seedRecipeBase, type SeedRecipe } from "../src/lib/assistant/recipe-base";
import { seedCategoryMetadata } from "./seed-categories";
import { seedMasterCatalog } from "./seed-master-catalog";
import { CatalogPruneRefusal } from "../src/lib/catalog-prune";
import type { R2SendClient } from "../src/lib/catalog-prune-fake-r2";
import recipeBase from "./recipe-base.json";

export type ProductionCatalogDeps = {
  csvPath?: string;
  log?: (line: string) => void;
  r2?: R2SendClient;
};

/**
 * What a production deploy loads (#802): category metadata, the master catalogue and the curated recipe base.
 * No demo store, catalogue, banner, collection, test admin or order. Each step keeps what a platform admin changed.
 */
export async function loadProductionCatalog(prisma: PrismaClient, deps: ProductionCatalogDeps = {}) {
  const log = deps.log ?? ((line: string) => console.log(line));
  // Production and previews share one R2 bucket that a lane or deploy does not own, so a prune never runs here.
  if (process.env.SEED_PRUNE_R2?.trim()) {
    throw new CatalogPruneRefusal("Refusing catalog prune: VERCEL_ENV is production");
  }
  await seedCategoryMetadata(prisma, undefined, log);
  await seedMasterCatalog(prisma, { csvPath: deps.csvPath, log, r2: deps.r2, execution: { kind: "production" } });
  const recipes = await seedRecipeBase(prisma, recipeBase as SeedRecipe[], log);
  log(`Production catalogue load done (${recipes} curated recipes)`);
}

if (process.env.VITEST !== "true") {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  loadProductionCatalog(prisma)
    .catch((error) => {
      console.error("Production catalogue load failed; the deploy stops here.");
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

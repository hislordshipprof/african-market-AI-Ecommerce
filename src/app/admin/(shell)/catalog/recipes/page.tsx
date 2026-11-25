import Link from "next/link";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { listRecipeBase } from "@/lib/admin/recipe-base-admin";
import { RECIPE_ORIGINS, RECIPE_ORIGIN_LABELS, recipeFiltersFromSearchParams, type RecipeFilters } from "@/lib/admin/recipe-base-form";
import { OriginLabel } from "./origin-label";

export const metadata = { title: "Recipes — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground ${FOCUS}`;

function pageHref(filters: RecipeFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.origin) params.set("origin", filters.origin);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/catalog/recipes${query ? `?${query}` : ""}`;
}

export default async function RecipesPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = recipeFiltersFromSearchParams(await props.searchParams);
  const data = await listRecipeBase(filters);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = !!(filters.q || filters.origin);
  const first = (data.page - 1) * data.pageSize + 1;
  const last = first + data.recipes.length - 1;

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Recipes</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        The dishes the shopper assistant knows. Looked-up dishes are saved from a web search with no review; check them here.
      </p>

      <form method="get" action="/admin/catalog/recipes" role="search" aria-label="Recipes" className="mt-6 grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
          <div className="grid gap-1.5">
            <label htmlFor="q" className="text-sm font-medium text-foreground">Dish name</label>
            <input id="q" name="q" type="search" defaultValue={filters.q ?? ""} maxLength={200} placeholder="Jollof rice, ndolé…" autoComplete="off" spellCheck={false} aria-describedby="q-hint" className={FIELD} />
            <p id="q-hint" className="text-sm text-muted-foreground">The full name or another name, as a shopper would ask for it.</p>
          </div>
          <div className="grid content-start gap-1.5">
            <label htmlFor="origin" className="text-sm font-medium text-foreground">Source</label>
            <select id="origin" name="origin" defaultValue={filters.origin ?? ""} className={FIELD}>
              <option value="">Curated and looked up</option>
              {RECIPE_ORIGINS.map((origin) => (
                <option key={origin} value={origin}>{RECIPE_ORIGIN_LABELS[origin]}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 ${FOCUS}`}>
            Show dishes
          </button>
          {filtered && (
            <Link href="/admin/catalog/recipes" className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-primary underline-offset-4 hover:underline ${FOCUS}`}>
              Clear filters
            </Link>
          )}
        </div>
      </form>

      <p className="mb-3 mt-8 text-sm text-muted-foreground" aria-live="polite" data-testid="recipe-count">
        {data.total === 0
          ? filters.q ? "No dish answers to that name. The assistant would look it up online." : "No dishes match."
          : `${first}–${last} of ${data.total} ${data.total === 1 ? "dish" : "dishes"}`}
      </p>

      {data.recipes.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {data.recipes.map((recipe) => (
            <li key={recipe.id} className="relative flex min-h-16 items-center gap-4 px-4 py-3 hover:bg-muted sm:px-5">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/admin/catalog/recipes/${recipe.id}`}
                  className="block break-words font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                >
                  {recipe.name}
                </Link>
                <span className="block text-sm text-muted-foreground">
                  {[
                    recipe.cuisine,
                    `${recipe.ingredientCount} ${recipe.ingredientCount === 1 ? "ingredient" : "ingredients"}, ${recipe.mappedCount} mapped`,
                    recipe.servings ? `serves ${recipe.servings}` : null,
                  ].filter(Boolean).join(", ")}
                </span>
                {recipe.sourceUrl && (
                  <a
                    href={recipe.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className={`relative z-10 mt-0.5 inline-flex max-w-full items-center gap-1 rounded-sm text-sm text-primary underline underline-offset-4 ${FOCUS}`}
                  >
                    <span className="truncate">{new URL(recipe.sourceUrl).host}</span>
                    <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                    <span className="sr-only"> (source of {recipe.name}, opens in a new tab)</span>
                  </a>
                )}
              </div>
              <OriginLabel origin={recipe.origin} />
              <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3">
          {data.page > 1 ? (
            <Link href={pageHref(filters, data.page - 1)} className={`inline-flex min-h-11 items-center gap-1 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted ${FOCUS}`}>
              <ChevronLeft aria-hidden className="size-4" /> Previous
            </Link>
          ) : <span />}
          <span className="text-sm text-muted-foreground">Page {data.page} of {pages}</span>
          {data.page < pages ? (
            <Link href={pageHref(filters, data.page + 1)} className={`inline-flex min-h-11 items-center gap-1 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted ${FOCUS}`}>
              Next <ChevronRight aria-hidden className="size-4" />
            </Link>
          ) : <span />}
        </nav>
      )}
    </div>
  );
}

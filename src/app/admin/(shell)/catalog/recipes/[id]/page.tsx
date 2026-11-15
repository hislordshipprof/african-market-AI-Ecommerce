import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { getRecipeEditor } from "@/lib/admin/recipe-base-admin";
import { OriginLabel } from "../origin-label";
import { RecipeForm } from "./recipe-form";
import { LookupActions } from "./lookup-actions";

export const metadata = { title: "Edit recipe — Platform Admin" };

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export default async function RecipeEditorPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const editor = await getRecipeEditor(id);
  if (!editor) notFound();
  const { recipe, products } = editor;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <Link
        href="/admin/catalog/recipes"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronLeft aria-hidden className="size-4" /> Recipes
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="break-words font-heading text-[28px] font-bold leading-tight text-foreground">{recipe.name}</h1>
        <OriginLabel origin={recipe.origin} />
      </div>
      <p className="mt-1 text-muted-foreground">
        {recipe.origin === "lookup" ? "Looked up online" : "Curated"}
        {recipe.cuisine ? `, ${recipe.cuisine}` : ""}. Saved {DATE.format(recipe.createdAt)}.
      </p>
      {recipe.sourceUrl && (
        <p className="mt-1 text-sm text-muted-foreground">
          Source:{" "}
          <a
            href={recipe.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex max-w-full items-center gap-1 break-all rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {recipe.sourceUrl}
            <ExternalLink aria-hidden className="size-3.5 shrink-0" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}

      <section aria-labelledby="details-heading" className="mt-8 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="details-heading" className="font-heading text-lg font-bold text-foreground">Dish</h2>
        <RecipeForm recipe={recipe} products={products} />
      </section>

      {recipe.origin === "lookup" && (
        <section aria-labelledby="review-heading" className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5">
          <h2 id="review-heading" className="font-heading text-lg font-bold text-foreground">Review</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Mark it curated once the ingredients are right. Delete it if the lookup got the dish wrong: the next shopper who asks for it gets a fresh lookup.
          </p>
          <LookupActions recipeId={recipe.id} version={recipe.version} name={recipe.name} />
        </section>
      )}
    </div>
  );
}

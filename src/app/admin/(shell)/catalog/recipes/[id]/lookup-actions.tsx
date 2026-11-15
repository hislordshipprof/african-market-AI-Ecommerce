"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { deleteRecipe, markRecipeCurated, type RecipeActionState } from "@/lib/admin/recipe-base-admin";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function LookupActions({ recipeId, name }: { recipeId: string; name: string }) {
  const router = useRouter();
  const [curateState, curate, curating] = useActionState<RecipeActionState, FormData>(markRecipeCurated, {});
  const [deleteState, remove, deleting] = useActionState<RecipeActionState, FormData>(deleteRecipe, {});

  useEffect(() => {
    if (curateState.ok) router.refresh();
  }, [curateState, router]);
  useEffect(() => {
    if (deleteState.ok) router.push("/admin/catalog/recipes");
  }, [deleteState, router]);

  const failed = [curateState, deleteState].find((state) => state.ok === false);

  return (
    <div className="mt-4 grid gap-3">
      <div className="flex flex-wrap gap-3">
        <form action={curate}>
          <input type="hidden" name="recipeId" value={recipeId} />
          <button
            type="submit"
            disabled={curating || deleting}
            className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`}
          >
            {curating ? "Marking…" : "Mark curated"}
          </button>
        </form>
        <form
          action={remove}
          onSubmit={(event) => {
            if (!window.confirm(`Delete ${name}? The next shopper who asks for it gets a new lookup.`)) event.preventDefault();
          }}
        >
          <input type="hidden" name="recipeId" value={recipeId} />
          <button
            type="submit"
            disabled={curating || deleting}
            className={`inline-flex min-h-11 items-center rounded-full border border-destructive px-5 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60 ${FOCUS}`}
          >
            {deleting ? "Deleting…" : "Delete dish"}
          </button>
        </form>
      </div>
      {failed && <p role="alert" className="text-sm text-destructive">{failed.message}</p>}
    </div>
  );
}

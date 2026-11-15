import { RECIPE_ORIGIN_LABELS, type RecipeOrigin } from "@/lib/admin/recipe-base-form";

export function OriginLabel({ origin }: { origin: RecipeOrigin }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        origin === "curated" ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground"
      }`}
    >
      {RECIPE_ORIGIN_LABELS[origin]}
    </span>
  );
}

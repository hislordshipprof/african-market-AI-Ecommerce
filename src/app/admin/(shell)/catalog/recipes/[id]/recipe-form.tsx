"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { saveRecipe, type RecipeEditor, type RecipeSaveState } from "@/lib/admin/recipe-base-admin";
import { MAX_RECIPE_INGREDIENTS } from "@/lib/admin/recipe-base-form";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground aria-[invalid=true]:border-destructive ${FOCUS}`;
const QUIET_BUTTON = `inline-flex min-h-11 items-center gap-1.5 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 ${FOCUS}`;

type Row = { uid: number; name: string; masterProductId: string; qty: string; unit: string };

export function RecipeForm({ recipe, products }: Pick<RecipeEditor, "recipe" | "products">) {
  const router = useRouter();
  const [state, action, saving] = useActionState<RecipeSaveState, FormData>(saveRecipe, {});
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  // The version the fields were loaded with; only this editor's own save moves it on.
  const version = useRef(recipe.version);
  const nextUid = useRef(recipe.ingredients.length);
  const [rows, setRows] = useState<Row[]>(() => recipe.ingredients.map((row, uid) => ({
    uid,
    name: row.name,
    masterProductId: row.masterProductId ?? "",
    qty: row.qty ?? "",
    unit: row.unit ?? "",
  })));
  const productNames = useMemo(() => {
    const names = new Map(products.map((product) => [product.id, product.name]));
    // A row may keep an archived product, which the pick list leaves out.
    for (const row of recipe.ingredients) if (row.masterProductId && row.masterProductName) names.set(row.masterProductId, row.masterProductName);
    return names;
  }, [products, recipe.ingredients]);

  useEffect(() => {
    if (state.ok) {
      if (state.version) version.current = state.version;
      router.refresh();
    } else formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state, router]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("version", version.current);
    startTransition(() => action(form));
  }

  const update = (uid: number, patch: Partial<Row>) => setRows((all) => all.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  const error = (field: string) => state.fieldErrors?.[field];
  const described = (field: string, id: string) => (error(field) ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {});

  return (
    <form ref={formRef} onSubmit={submit} noValidate autoComplete="off" className="mt-4 grid gap-4">
      <input type="hidden" name="recipeId" value={recipe.id} />

      <Field id="name" label="Name" hint={`Shoppers find it by this name. Today it answers to “${recipe.key}”.`} error={error("name")}>
        <input id="name" name="name" defaultValue={recipe.name} required maxLength={200} className={FIELD} {...described("name", "name")} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field id="aliases" label="Other names" hint="One per line: local names and spellings shoppers use." error={error("aliases")}>
          <textarea id="aliases" name="aliases" defaultValue={recipe.aliases.join("\n")} rows={3} className={`${FIELD} py-2`} {...described("aliases", "aliases")} />
        </Field>
        <Field id="servings" label="Servings" hint="What the quantities are for." error={error("servings")}>
          <input id="servings" name="servings" inputMode="numeric" defaultValue={recipe.servings ?? ""} className={FIELD} {...described("servings", "servings")} />
        </Field>
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium text-foreground">Ingredients</legend>
        {error("ingredients") && <p id="ingredients-error" className="text-sm text-destructive">{error("ingredients")}</p>}
        <datalist id="recipe-products">
          {products.map((product) => (
            <option key={product.id} value={product.id}>{product.name}</option>
          ))}
        </datalist>
        <ol className="grid gap-3">
          {rows.map((row, index) => {
            const field = (name: string) => `ingredients.${index}.${name}`;
            const id = (name: string) => `ingredient-${row.uid}-${name}`;
            const mapped = row.masterProductId ? productNames.get(row.masterProductId.trim()) : undefined;
            return (
              <li key={row.uid} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_6rem_6rem_auto] sm:items-start">
                <Field id={id("name")} label="Ingredient" error={error(field("name"))}>
                  <input id={id("name")} name="ingredientName" value={row.name} onChange={(event) => update(row.uid, { name: event.target.value })} maxLength={100} className={FIELD} {...described(field("name"), id("name"))} />
                </Field>
                <Field
                  id={id("product")}
                  label="Master product"
                  hint={row.masterProductId ? mapped ?? "Not a product in the list" : "Not mapped"}
                  error={error(field("masterProductId"))}
                >
                  <input
                    id={id("product")}
                    name="ingredientProduct"
                    list="recipe-products"
                    value={row.masterProductId}
                    onChange={(event) => update(row.uid, { masterProductId: event.target.value })}
                    placeholder="Product id"
                    spellCheck={false}
                    className={FIELD}
                    {...described(field("masterProductId"), id("product"))}
                  />
                </Field>
                <Field id={id("qty")} label="Quantity" error={error(field("qty"))}>
                  <input id={id("qty")} name="ingredientQty" inputMode="decimal" value={row.qty} onChange={(event) => update(row.uid, { qty: event.target.value })} className={FIELD} {...described(field("qty"), id("qty"))} />
                </Field>
                <Field id={id("unit")} label="Unit" error={error(field("unit"))}>
                  <input id={id("unit")} name="ingredientUnit" value={row.unit} onChange={(event) => update(row.uid, { unit: event.target.value })} maxLength={20} className={FIELD} {...described(field("unit"), id("unit"))} />
                </Field>
                <button
                  type="button"
                  onClick={() => setRows((all) => all.filter((item) => item.uid !== row.uid))}
                  disabled={rows.length === 1}
                  className={`${QUIET_BUTTON} justify-self-start sm:mt-[1.625rem]`}
                >
                  <X aria-hidden className="size-4" /> Remove<span className="sr-only"> {row.name || `ingredient ${index + 1}`}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div>
          <button
            type="button"
            disabled={rows.length >= MAX_RECIPE_INGREDIENTS}
            onClick={() => {
              const uid = nextUid.current++;
              setRows((all) => [...all, { uid, name: "", masterProductId: "", qty: "", unit: "" }]);
            }}
            className={QUIET_BUTTON}
          >
            <Plus aria-hidden className="size-4" /> Add ingredient
          </button>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={saving}
          className={`inline-flex min-h-11 items-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <p role="status" className={`text-sm ${state.ok === false ? "text-destructive" : "text-muted-foreground"}`}>
          {saving ? "" : state.message ?? ""}
        </p>
      </div>
    </form>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      {children}
      {hint && !error && <p className="break-words text-sm text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

"use client";

import { useActionState, useEffect, useId, useRef, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  createCategory,
  deleteCategory,
  moveCategory,
  updateCategory,
  type CategoryEditor,
  type CategoryState,
} from "@/lib/admin/catalog-categories";
import type { CategoryField } from "@/lib/admin/catalog-structure-form";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground aria-[invalid=true]:border-destructive ${FOCUS}`;
const PRIMARY = `inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`;

/** Adds a category (no `category`) or edits one. */
export function CategoryForm({ category, parents, onTopLevelOnly }: {
  category?: CategoryEditor["category"];
  parents: Array<{ id: string; name: string }>;
  /** Why the parent list is empty for this category, when it is. */
  onTopLevelOnly?: string;
}) {
  const router = useRouter();
  const prefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, saving] = useActionState<CategoryState, FormData>(category ? updateCategory : createCategory, {});
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (state.ok) {
      if (!category) formRef.current?.reset();
      router.refresh();
    } else formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state, router, category]);

  // Submitting through a transition keeps what the admin typed when a field is refused.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  }

  const id = (field: CategoryField) => `${prefix}-${field}`;
  const error = (field: CategoryField) => state.fieldErrors?.[field];
  const described = (field: CategoryField) => (error(field) ? { "aria-invalid": true, "aria-describedby": `${id(field)}-error` } : {});

  return (
    <form ref={formRef} onSubmit={submit} noValidate autoComplete="off" className="mt-4 grid gap-4">
      {category && <input type="hidden" name="categoryId" value={category.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={id("name")} label="Name" error={error("name")}>
          <input id={id("name")} name="name" defaultValue={category?.name ?? ""} maxLength={60} className={FIELD} {...described("name")} />
        </Field>
        <Field id={id("localName")} label="Local name" hint="Shown under the name on the storefront, such as EWA · WAKE" error={error("localName")}>
          <input id={id("localName")} name="localName" defaultValue={category?.localName ?? ""} maxLength={60} spellCheck={false} className={FIELD} {...described("localName")} />
        </Field>
      </div>
      <Field
        id={id("parentId")}
        label="Parent"
        hint={onTopLevelOnly ?? "A subcategory sits under one top-level category. There is no deeper level."}
        error={error("parentId")}
      >
        <select
          id={id("parentId")}
          name="parentId"
          defaultValue={category?.parentId ?? ""}
          disabled={parents.length === 0 && !category?.parentId}
          className={`${FIELD} sm:max-w-sm disabled:opacity-60`}
          {...described("parentId")}
        >
          <option value="">None (top level)</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>{parent.name}</option>
          ))}
        </select>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving} className={PRIMARY}>
          {saving ? "Saving…" : category ? "Save changes" : "Add category"}
        </button>
        <p role="status" className={`text-sm ${state.ok === false ? "text-destructive" : "text-muted-foreground"}`}>
          {saving ? "" : state.message ?? ""}
        </p>
      </div>
    </form>
  );
}

/** Up and down among the category's siblings. */
export function MoveButtons({ categoryId, name, first, last }: { categoryId: string; name: string; first: boolean; last: boolean }) {
  const router = useRouter();
  const [moving, startMove] = useTransition();

  function move(direction: "up" | "down") {
    startMove(async () => {
      await moveCategory(categoryId, direction);
      router.refresh();
    });
  }

  const button = `inline-flex size-11 items-center justify-center rounded-full border border-input text-foreground hover:bg-muted disabled:opacity-40 ${FOCUS}`;
  return (
    <span className="flex shrink-0 gap-1.5">
      <button type="button" disabled={first || moving} onClick={() => move("up")} className={button} aria-label={`Move ${name} up`}>
        <ArrowUp aria-hidden className="size-4" />
      </button>
      <button type="button" disabled={last || moving} onClick={() => move("down")} className={button} aria-label={`Move ${name} down`}>
        <ArrowDown aria-hidden className="size-4" />
      </button>
    </span>
  );
}

/** Deletes an empty category, then returns to the list. The server refuses one with products or subcategories. */
export function DeleteCategoryForm({ categoryId, name }: { categoryId: string; name: string }) {
  const router = useRouter();
  const [state, action, deleting] = useActionState<CategoryState, FormData>(deleteCategory, {});

  useEffect(() => {
    if (state.ok) router.push("/admin/catalog/categories");
  }, [state, router]);

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`Delete ${name}? This cannot be undone.`)) event.preventDefault();
      }}
      className="mt-3 flex flex-wrap items-center gap-3"
    >
      <input type="hidden" name="categoryId" value={categoryId} />
      <button
        type="submit"
        disabled={deleting}
        className={`inline-flex min-h-11 items-center rounded-full border border-destructive px-5 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60 ${FOCUS}`}
      >
        {deleting ? "Deleting…" : "Delete category"}
      </button>
      <p role="status" className={`text-sm ${state.ok === false ? "text-destructive" : "text-muted-foreground"}`}>
        {deleting ? "" : state.message ?? ""}
      </p>
    </form>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      {children}
      {hint && !error && <p className="text-sm text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

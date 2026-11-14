"use client";

import { useActionState, useEffect, useRef, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { saveMasterProduct, type MasterProductEditor, type SaveState } from "@/lib/admin/master-catalog";
import { MASTER_STATUSES, MASTER_STATUS_LABELS, STORAGE_OPTIONS, type MasterProductField } from "@/lib/admin/master-catalog-form";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground aria-[invalid=true]:border-destructive ${FOCUS}`;
const STORAGE_LABELS: Record<(typeof STORAGE_OPTIONS)[number], string> = { ambient: "Room temperature", chilled: "Chilled", frozen: "Frozen" };

export function ProductForm({ product, categories }: Pick<MasterProductEditor, "product" | "categories">) {
  const router = useRouter();
  const [state, action, saving] = useActionState<SaveState, FormData>(saveMasterProduct, {});
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) router.refresh();
    else formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state, router]);

  // Submitting through a transition keeps what the admin typed when a field is refused.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  }

  const error = (field: MasterProductField) => state.fieldErrors?.[field];
  const described = (field: MasterProductField) => (error(field) ? { "aria-invalid": true, "aria-describedby": `${field}-error` } : {});

  return (
    <form ref={formRef} onSubmit={submit} noValidate autoComplete="off" className="mt-4 grid gap-4">
      <input type="hidden" name="productId" value={product.id} />

      <Field id="name" label="Name" error={error("name")}>
        <input id="name" name="name" defaultValue={product.name} required maxLength={200} className={FIELD} {...described("name")} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="categoryId" label="Category" error={error("categoryId")}>
          <select id="categoryId" name="categoryId" defaultValue={product.categoryId ?? ""} className={FIELD} {...described("categoryId")}>
            <option value="">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </Field>
        <Field id="subcategory" label="Subcategory" error={error("subcategory")}>
          <input id="subcategory" name="subcategory" defaultValue={product.subcategory ?? ""} maxLength={100} className={FIELD} {...described("subcategory")} />
        </Field>
      </div>

      <Field id="description" label="Description" error={error("description")}>
        <textarea
          id="description"
          name="description"
          defaultValue={product.description ?? ""}
          maxLength={5000}
          rows={4}
          className={`${FIELD} py-2`}
          {...described("description")}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="unit" label="Unit" hint="Bag, bottle, pack" error={error("unit")}>
          <input id="unit" name="unit" defaultValue={product.unit ?? ""} maxLength={40} className={FIELD} {...described("unit")} />
        </Field>
        <Field id="weightG" label="Weight (grams)" error={error("weightG")}>
          <input id="weightG" name="weightG" inputMode="numeric" defaultValue={product.weightG ?? ""} className={FIELD} {...described("weightG")} />
        </Field>
        <Field id="storage" label="Storage" error={error("storage")}>
          <select id="storage" name="storage" defaultValue={product.storage ?? ""} className={FIELD} {...described("storage")}>
            <option value="">Not set</option>
            {STORAGE_OPTIONS.map((option) => (
              <option key={option} value={option}>{STORAGE_LABELS[option]}</option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-foreground">Handling</legend>
        <Check name="frozen" label="Frozen" defaultChecked={product.frozen} />
        <Check name="perishable" label="Perishable" defaultChecked={product.perishable} />
      </fieldset>

      <Field id="status" label="Status" hint="Archived products take no new listings. Stores already selling one keep selling it." error={error("status")}>
        <select id="status" name="status" defaultValue={product.status} className={`${FIELD} sm:max-w-xs`} {...described("status")}>
          {MASTER_STATUSES.map((status) => (
            <option key={status} value={status}>{MASTER_STATUS_LABELS[status]}</option>
          ))}
        </select>
      </Field>

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
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      {children}
      {hint && !error && <p className="text-sm text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="inline-flex min-h-11 items-center gap-3 text-base text-foreground">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className={`size-5 accent-primary ${FOCUS}`} />
      {label}
    </label>
  );
}

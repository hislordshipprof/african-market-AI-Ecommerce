import Link from "next/link";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { listCatalogCategories, listMasterCatalog } from "@/lib/admin/master-catalog";
import {
  MASTER_STATUSES,
  MASTER_STATUS_LABELS,
  catalogFiltersFromSearchParams,
  type CatalogFilters,
} from "@/lib/admin/master-catalog-form";

export const metadata = { title: "Products — Platform Admin" };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground ${FOCUS}`;

function pageHref(filters: CatalogFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.category) params.set("category", filters.category);
  if (filters.status) params.set("status", filters.status);
  if (filters.photo) params.set("photo", filters.photo);
  if (filters.attributes) params.set("attributes", filters.attributes);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/catalog/products${query ? `?${query}` : ""}`;
}

export default async function MasterProductsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = catalogFiltersFromSearchParams(await props.searchParams);
  const [data, categories] = await Promise.all([listMasterCatalog(filters), listCatalogCategories()]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = !!(filters.q || filters.category || filters.status || filters.photo || filters.attributes);
  const first = (data.page - 1) * data.pageSize + 1;
  const last = first + data.products.length - 1;

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Products</h1>
      <p className="mt-1 text-muted-foreground">
        The master catalog every store lists from. Archive a product to stop new listings; existing ones keep selling.
      </p>

      <form method="get" action="/admin/catalog/products" role="search" aria-label="Products" className="mt-6 grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="grid gap-1.5">
          <label htmlFor="q" className="text-sm font-medium text-foreground">Search</label>
          <input id="q" name="q" type="search" defaultValue={filters.q ?? ""} maxLength={200} placeholder="Egusi, gari, palm oil…" autoComplete="off" spellCheck={false} className={FIELD} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect id="category" label="Category" value={filters.category} options={categories.flatMap((aisle) => [{ value: aisle.id, label: aisle.name }, ...aisle.subcategories.map((sub) => ({ value: sub.id, label: `${aisle.name} › ${sub.name}` }))])} />
          <FilterSelect id="status" label="Status" value={filters.status} options={MASTER_STATUSES.map((s) => ({ value: s, label: MASTER_STATUS_LABELS[s] }))} />
          <FilterSelect id="photo" label="Photo" value={filters.photo} anyLabel="With or without" options={[{ value: "missing", label: "Missing photo" }]} />
          <FilterSelect
            id="attributes"
            label="Attributes"
            value={filters.attributes}
            options={[{ value: "unreviewed", label: "Not all reviewed" }, { value: "reviewed", label: "All reviewed" }]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 ${FOCUS}`}>
            Show products
          </button>
          {filtered && (
            <Link href="/admin/catalog/products" className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-primary underline-offset-4 hover:underline ${FOCUS}`}>
              Clear filters
            </Link>
          )}
        </div>
      </form>

      <p className="mb-3 mt-8 text-sm text-muted-foreground" aria-live="polite" data-testid="catalog-count">
        {data.total === 0
          ? "No products match."
          : `${first}–${last} of ${data.total} ${data.total === 1 ? "product" : "products"}`}
      </p>

      {data.products.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {data.products.map((product) => (
            <li key={product.id}>
              <Link
                href={`/admin/catalog/products/${product.id}`}
                className="group flex min-h-16 items-center gap-4 px-4 py-3 hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring sm:px-5"
              >
                <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {product.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.imageUrl} alt="" className="size-full object-cover" loading="lazy" />
                  ) : (
                    <ImageOff aria-hidden className="size-5 text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium text-foreground">{product.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {[product.categoryName ?? "No category", product.subcategory, product.unit, product.imageUrl ? null : "no photo"].filter(Boolean).join(", ")}
                  </span>
                </span>
                <span className="hidden shrink-0 text-sm text-muted-foreground sm:block">
                  {product.attributesReviewed ? "Attributes reviewed" : "Attributes to review"}
                </span>
                <StatusLabel status={product.status} />
                <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </Link>
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

function FilterSelect({ id, label, value, options, anyLabel = "All" }: {
  id: string;
  label: string;
  value: string | undefined;
  options: Array<{ value: string; label: string }>;
  anyLabel?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      <select id={id} name={id} defaultValue={value ?? ""} className={FIELD}>
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function StatusLabel({ status }: { status: keyof typeof MASTER_STATUS_LABELS }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        status === "active" ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground"
      }`}
    >
      {MASTER_STATUS_LABELS[status]}
    </span>
  );
}

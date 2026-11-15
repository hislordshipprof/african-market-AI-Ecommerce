import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ImageOff } from "lucide-react";
import { getMasterProductEditor } from "@/lib/admin/master-catalog";
import { MASTER_STATUS_LABELS } from "@/lib/admin/master-catalog-form";
import { ProductForm } from "./product-form";
import { PhotoForm } from "./photo-form";

export const metadata = { title: "Edit product — Platform Admin" };

const ATTRIBUTE_LABELS: Record<string, string> = { unknown: "Not known", known: "From a store owner", reviewed: "Reviewed" };

export default async function MasterProductEditorPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const editor = await getMasterProductEditor(id);
  if (!editor) notFound();
  const { product, categories, storeCount, mergedInto } = editor;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <Link
        href="/admin/catalog/products"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronLeft aria-hidden className="size-4" /> Products
      </Link>
      <h1 className="mt-2 font-heading text-[28px] font-bold leading-tight text-foreground">{product.name}</h1>
      {mergedInto ? (
        <p className="mt-1 text-muted-foreground">
          Merged into{" "}
          <Link href={`/admin/catalog/products/${mergedInto.id}`} className="font-medium text-primary underline underline-offset-4">
            {mergedInto.name}
          </Link>
          . Its listings and synonyms moved there, and it can no longer be edited.
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">
          {MASTER_STATUS_LABELS[product.status]}.{" "}
          {storeCount === 0 ? "No store lists it yet." : `${storeCount} ${storeCount === 1 ? "store lists" : "stores list"} it; saving refreshes their storefronts.`}
        </p>
      )}

      {!mergedInto && (
        <>
          <section aria-labelledby="photo-heading" className="mt-8 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 id="photo-heading" className="font-heading text-lg font-bold text-foreground">Photo</h2>
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                {product.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={product.imageUrl} alt={`${product.name} photo`} className="size-full object-cover" />
                ) : (
                  <ImageOff role="img" aria-label="No photo yet" className="size-8 text-muted-foreground" />
                )}
              </div>
              <PhotoForm productId={product.id} />
            </div>
          </section>

          <section aria-labelledby="details-heading" className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 id="details-heading" className="font-heading text-lg font-bold text-foreground">Details</h2>
            <ProductForm product={product} categories={categories} />
          </section>
        </>
      )}

      <section aria-labelledby="attributes-heading" className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="attributes-heading" className="font-heading text-lg font-bold text-foreground">Ingredients, allergens and dietary claims</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          {([["Ingredients", product.ingredientsStatus], ["Allergens", product.allergensStatus], ["Dietary claims", product.dietaryStatus]] as const).map(([label, status]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium text-foreground">{ATTRIBUTE_LABELS[status] ?? status}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          These change only through{" "}
          <Link href="/admin/catalog/review?status=attributes" className="font-medium text-primary underline underline-offset-4">
            Catalog review
          </Link>
          , where Claude&apos;s reading of the label is checked.
        </p>
      </section>
    </div>
  );
}

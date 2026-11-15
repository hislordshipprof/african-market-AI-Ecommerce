import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ImageOff } from "lucide-react";
import { getCategoryEditor, uploadCategoryImage } from "@/lib/admin/catalog-categories";
import { PhotoForm } from "../../photo-form";
import { CategoryForm, DeleteCategoryForm } from "../category-forms";

export const metadata = { title: "Edit category — Platform Admin" };

export default async function CategoryEditorPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const editor = await getCategoryEditor(id);
  if (!editor) notFound();
  const { category, productCount, childCount, parents } = editor;
  const deletable = productCount === 0 && childCount === 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <Link
        href="/admin/catalog/categories"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronLeft aria-hidden className="size-4" /> Categories
      </Link>
      <h1 className="mt-2 break-words font-heading text-[28px] font-bold leading-tight text-foreground">{category.name}</h1>
      <p className="mt-1 text-muted-foreground">
        {productCount === 0 ? "No products in it yet." : `${productCount} ${productCount === 1 ? "product" : "products"}; saving refreshes the storefronts that sell them.`}{" "}
        Its address stays /categories/{category.slug} when you rename it.
      </p>

      <section aria-labelledby="details-heading" className="mt-8 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="details-heading" className="font-heading text-lg font-bold text-foreground">Details</h2>
        <CategoryForm
          category={category}
          parents={parents}
          onTopLevelOnly={childCount > 0 ? "It has subcategories, so it stays top level." : undefined}
        />
      </section>

      <section aria-labelledby="photo-heading" className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="photo-heading" className="font-heading text-lg font-bold text-foreground">Photo</h2>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
            {category.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={category.imageUrl} alt={`${category.name} photo`} className="size-full object-cover" />
            ) : (
              <ImageOff role="img" aria-label="No photo yet" className="size-8 text-muted-foreground" />
            )}
          </div>
          <PhotoForm field="categoryId" id={category.id} upload={uploadCategoryImage} />
        </div>
      </section>

      <section aria-labelledby="delete-heading" className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="delete-heading" className="font-heading text-lg font-bold text-foreground">Delete</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {deletable
            ? "Nothing is in this category, so it can be deleted."
            : productCount > 0
              ? "Move its products to another category first. A category with products cannot be deleted."
              : "Move or delete its subcategories first."}
        </p>
        {deletable && <DeleteCategoryForm categoryId={category.id} name={category.name} />}
      </section>
    </div>
  );
}

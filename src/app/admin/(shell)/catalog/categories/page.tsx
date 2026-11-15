import Link from "next/link";
import { ChevronRight, ImageOff } from "lucide-react";
import { listCategoryTree, type CategoryNode } from "@/lib/admin/catalog-categories";
import { CategoryForm, MoveButtons } from "./category-forms";

export const metadata = { title: "Categories — Platform Admin" };

export default async function CategoriesPage() {
  const tree = await listCategoryTree();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Categories</h1>
      <p className="mt-1 text-muted-foreground">
        The aisles every storefront shows, in this order. A category can hold subcategories one level deep.
      </p>

      <section aria-labelledby="add-heading" className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="add-heading" className="font-heading text-lg font-bold text-foreground">Add a category</h2>
        <CategoryForm parents={tree.map(({ id, name }) => ({ id, name }))} />
      </section>

      <h2 className="mt-8 font-heading text-lg font-bold text-foreground">
        {tree.length === 0 ? "No categories yet" : `${tree.length} top-level ${tree.length === 1 ? "category" : "categories"}`}
      </h2>
      {tree.length > 0 && (
        <ol className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" aria-label="Categories">
          {tree.map((category, index) => (
            <li key={category.id}>
              <CategoryRow category={category} first={index === 0} last={index === tree.length - 1} />
              {category.children.length > 0 && (
                <ol className="border-t border-border bg-background/40" aria-label={`Subcategories of ${category.name}`}>
                  {category.children.map((child, childIndex) => (
                    <li key={child.id} className="border-t border-border first:border-t-0">
                      <CategoryRow category={child} first={childIndex === 0} last={childIndex === category.children.length - 1} nested />
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CategoryRow({ category, first, last, nested = false }: { category: CategoryNode; first: boolean; last: boolean; nested?: boolean }) {
  const details = [
    category.localName,
    `${category.productCount} ${category.productCount === 1 ? "product" : "products"}`,
    category.children.length > 0 ? `${category.children.length} ${category.children.length === 1 ? "subcategory" : "subcategories"}` : null,
  ].filter(Boolean).join(", ");

  return (
    <div className={`flex min-h-16 items-center gap-3 py-3 pr-3 sm:gap-4 sm:pr-5 ${nested ? "pl-8 sm:pl-12" : "pl-3 sm:pl-5"}`}>
      <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted ${nested ? "size-10" : "size-12"}`}>
        {category.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={category.imageUrl} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <ImageOff aria-hidden className="size-5 text-muted-foreground" />
        )}
      </span>
      <Link
        href={`/admin/catalog/categories/${category.id}`}
        className={`group flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
      >
        <span className="min-w-0 flex-1">
          <span className="block break-words font-medium text-foreground group-hover:underline group-hover:underline-offset-4">{category.name}</span>
          <span className="block break-words text-sm text-muted-foreground">{details}</span>
        </span>
        <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
      </Link>
      <MoveButtons categoryId={category.id} name={category.name} first={first} last={last} />
    </div>
  );
}

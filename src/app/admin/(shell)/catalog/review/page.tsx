import Link from "next/link";
import { listAttributeProposals, listReviewProducts, getReviewStats } from "@/lib/admin/catalog-actions";
import { listCatalogCategories } from "@/lib/admin/master-catalog";
import { listProductProposals } from "@/lib/admin/product-proposals";
import { AttributeProposals } from "./attribute-proposals";
import { ProductProposals } from "./product-proposals";
import { ReviewTable } from "./review-table";

export const metadata = { title: "Catalog Review — Platform Admin" };

export default async function CatalogReviewPage(props: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const searchParams = await props.searchParams;
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const status = searchParams.status ?? "needs_review";

  const [data, stats, proposals, suggestions, categories] = await Promise.all([
    listReviewProducts({ status, page, pageSize: 25 }),
    getReviewStats(),
    listAttributeProposals(),
    listProductProposals(),
    status === "suggestions" ? listCatalogCategories() : Promise.resolve([]),
  ]);

  const tabs = [
    { key: "needs_review", label: "Needs review", count: stats.needsReview },
    { key: "active", label: "Active", count: stats.active },
    { key: "rejected", label: "Rejected", count: stats.rejected },
    { key: "attributes", label: "Attributes", count: proposals.length },
    { key: "suggestions", label: "Store suggestions", count: suggestions.length },
  ];

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Catalog review
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {stats.total} products total &middot; {stats.needsReview} awaiting review
          </p>
        </div>
      </div>

      {/* Status tabs */}
      <div className="mb-6 flex flex-wrap gap-1 rounded-xl border border-border bg-muted p-1">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={`/admin/catalog/review?status=${tab.key}`}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              status === tab.key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-xs font-semibold ${
              status === tab.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            }`}>
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {status === "attributes" ? (
        <AttributeProposals proposals={proposals} />
      ) : status === "suggestions" ? (
        <ProductProposals proposals={suggestions} categories={categories} />
      ) : (
        <ReviewTable
          products={data.products}
          total={data.total}
          page={data.page}
          pageSize={data.pageSize}
        />
      )}
    </div>
  );
}

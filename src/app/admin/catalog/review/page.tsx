import Link from "next/link";
import { listAttributeProposals, listReviewProducts, getReviewStats } from "@/lib/admin/catalog-actions";
import { AttributeProposals } from "./attribute-proposals";
import { ReviewTable } from "./review-table";

export const metadata = { title: "Catalog Review — Platform Admin" };

export default async function CatalogReviewPage(props: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const searchParams = await props.searchParams;
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const status = searchParams.status ?? "needs_review";

  const [data, stats, proposals] = await Promise.all([
    listReviewProducts({ status, page, pageSize: 25 }),
    getReviewStats(),
    listAttributeProposals(),
  ]);

  const tabs = [
    { key: "needs_review", label: "Needs review", count: stats.needsReview },
    { key: "active", label: "Active", count: stats.active },
    { key: "rejected", label: "Rejected", count: stats.rejected },
    { key: "attributes", label: "Attributes", count: proposals.length },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href="/admin"
            className="mb-1 inline-block text-xs font-medium text-[#55625A] hover:text-[#1F5A43] dark:text-[#A3B1A7]"
          >
            &larr; Admin
          </Link>
          <h1 className="text-2xl font-bold text-[#15201A] dark:text-[#EEF2EC]">
            Catalog review
          </h1>
          <p className="mt-1 text-sm text-[#55625A] dark:text-[#A3B1A7]">
            {stats.total} products total &middot; {stats.needsReview} awaiting review
          </p>
        </div>
      </div>

      {/* Status tabs */}
      <div className="mb-6 flex gap-1 rounded-xl border border-[#DCDFD6] bg-[#F3F4EF] p-1 dark:border-[#35463B] dark:bg-[#0D1410]">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={`/admin/catalog/review?status=${tab.key}`}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              status === tab.key
                ? "bg-white text-[#15201A] shadow-sm dark:bg-[#1E2C23] dark:text-[#EEF2EC]"
                : "text-[#55625A] hover:text-[#15201A] dark:text-[#A3B1A7] dark:hover:text-[#EEF2EC]"
            }`}
          >
            {tab.label}
            <span className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-xs font-semibold ${
              status === tab.key
                ? "bg-[#1F5A43] text-white"
                : "bg-[#DCDFD6] text-[#55625A] dark:bg-[#35463B] dark:text-[#A3B1A7]"
            }`}>
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {status === "attributes" ? (
        <AttributeProposals proposals={proposals} />
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

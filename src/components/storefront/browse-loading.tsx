import { CardSkeleton, MosaicSkeleton } from "./skeleton";
export function BrowseLoading({
  kind = "grid",
}: {
  kind?: "grid" | "detail" | "mosaic" | "collection" | "account";
}) {
  return (
    <div className="sf-storefront" aria-busy="true" aria-label="Loading market">
      <div className="sf-container sf-stack">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-11 w-full rounded-full" />
        <div className="skeleton h-4 w-40" />
        {kind === "detail" ? (
          <div className="sf-detail">
            <div className="skeleton aspect-square rounded-xl" />
            <div className="space-y-6">
              <div className="skeleton h-10 w-3/4" />
              <div className="skeleton h-6 w-1/2" />
              <div className="skeleton h-12 w-24" />
              <div className="flex gap-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-20 w-28 rounded-xl" />
                ))}
              </div>
              <div className="skeleton h-24 w-full" />
              <div className="skeleton h-16 w-full rounded-xl" />
            </div>
          </div>
        ) : kind === "mosaic" ? (
          <MosaicSkeleton />
        ) : kind === "account" ? (
          <div className="sf-empty">
            <div className="skeleton h-16 w-16 rounded-full" />
            <div className="skeleton h-6 w-64" />
            <div className="skeleton h-12 w-3/4" />
            <div className="skeleton h-12 w-48 rounded-full" />
          </div>
        ) : (
          <>
            {kind === "collection" && (
              <div className="skeleton h-72 rounded-xl" />
            )}
            <div className="sf-grid">
              {Array.from({ length: 8 }, (_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

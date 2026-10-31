import { ListRowSkeleton } from "@/components/storefront/skeleton";

export default function SearchLoading() {
  return (
    <main className="min-h-screen bg-bg">
      <div className="bg-primary">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
          <div className="h-7 w-48 skeleton rounded-md" />
          <div className="mt-4 h-[44px] w-full rounded-pill skeleton" />
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div className="mb-4 flex items-center gap-1.5">
          <div className="h-3.5 w-10 skeleton" />
          <div className="h-3.5 w-3 skeleton" />
          <div className="h-3.5 w-14 skeleton" />
        </div>

        <div className="mb-4 h-6 w-44 skeleton" />

        <div className="divide-y divide-line rounded-md border border-line bg-surface">
          {Array.from({ length: 6 }, (_, i) => (
            <ListRowSkeleton key={i} />
          ))}
        </div>
      </div>
    </main>
  );
}

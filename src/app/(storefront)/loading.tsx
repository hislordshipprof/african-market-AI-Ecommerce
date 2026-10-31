import { CardSkeleton, CategoryPillSkeleton } from "@/components/storefront/skeleton";

export default function HomeLoading() {
  return (
    <main className="min-h-screen bg-bg">
      <div className="bg-primary">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
          <div className="h-7 w-48 skeleton rounded-md" />
          <div className="mt-4 h-[44px] w-full rounded-pill skeleton" />
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <section>
          <div className="mb-4 h-6 w-40 skeleton" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <CategoryPillSkeleton key={i} />
            ))}
          </div>
        </section>

        <section className="mt-8">
          <div className="mb-4 h-6 w-36 skeleton" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

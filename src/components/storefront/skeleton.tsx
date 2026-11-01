export function CardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-md bg-surface">
      <div className="aspect-square w-full skeleton" />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="h-4 w-3/4 skeleton" />
        <div className="h-3 w-1/2 skeleton" />
        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <div className="h-5 w-16 skeleton" />
          <div className="h-5 w-14 rounded-pill skeleton" />
        </div>
      </div>
    </div>
  );
}

export function CategoryPillSkeleton() {
  return (
    <div className="flex items-center gap-2.5 rounded-md bg-surface px-4 py-3">
      <div className="h-8 w-8 shrink-0 rounded-full skeleton" />
      <div className="h-3 w-16 skeleton" />
    </div>
  );
}

export function ListRowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="h-4 w-2/3 skeleton" />
        <div className="h-3 w-1/3 skeleton" />
      </div>
      <div className="h-5 w-14 rounded-pill skeleton" />
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="overflow-hidden rounded-md bg-surface">
      <div className="aspect-[4/3] w-full skeleton sm:aspect-[16/9]" />
      <div className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 space-y-2">
            <div className="h-7 w-2/3 skeleton" />
            <div className="h-4 w-1/3 skeleton" />
          </div>
          <div className="h-6 w-16 rounded-pill skeleton" />
        </div>
        <div className="space-y-2">
          <div className="h-5 w-28 skeleton" />
          <div className="divide-y divide-line rounded-md border border-line">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="space-y-1">
                  <div className="h-4 w-24 skeleton" />
                  <div className="h-3 w-12 skeleton" />
                </div>
                <div className="h-5 w-14 skeleton" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function HeroSkeleton() {
  return (
    <div
      className="w-full skeleton"
      style={{ aspectRatio: "16/9", maxHeight: 400 }}
    />
  );
}

export function RailSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-6 w-40 skeleton" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="w-40 shrink-0 sm:w-48">
            <CardSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MosaicSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-6 w-40 skeleton" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="skeleton rounded-md"
            style={{ aspectRatio: "4/3" }}
          />
        ))}
      </div>
    </div>
  );
}

export function BannerSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-6 w-48 skeleton" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <div
            key={i}
            className="skeleton rounded-lg"
            style={{ aspectRatio: "21/9" }}
          />
        ))}
      </div>
    </div>
  );
}

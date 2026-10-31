import {
  HeroSkeleton,
  MosaicSkeleton,
  RailSkeleton,
  BannerSkeleton,
} from "@/components/storefront/skeleton";

export default function HomeLoading() {
  return (
    <main className="min-h-screen bg-bg">
      <div className="sticky top-0 z-40 bg-primary shadow-sm">
        <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="h-7 w-48 skeleton rounded-md" />
            <div className="ml-auto h-11 w-11 rounded-full skeleton" />
          </div>
          <div className="mt-2 h-[44px] w-full rounded-pill skeleton" />
        </div>
      </div>

      <HeroSkeleton />

      <div className="mx-auto max-w-6xl space-y-10 px-4 py-8 sm:px-6">
        <MosaicSkeleton />
        <RailSkeleton />
        <RailSkeleton />
        <BannerSkeleton />
      </div>
    </main>
  );
}

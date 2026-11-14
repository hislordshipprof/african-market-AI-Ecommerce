import { CardSkeleton } from "@/components/storefront/skeleton";
export default function Loading() {
  return (
    <main
      className="sf-storefront sf-section"
      aria-busy="true"
      aria-label="Loading your store"
    >
      <div className="sf-container sf-stack">
        <div className="h-20 w-full skeleton" />
        <div className="h-80 w-full skeleton" />
        <div className="h-10 w-64 skeleton" />
        <div className="sf-grid">
          {Array.from({ length: 5 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    </main>
  );
}

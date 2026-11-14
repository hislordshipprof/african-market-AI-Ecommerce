import { CardSkeleton } from "@/components/storefront/skeleton";
export default function Loading() {
  return (
    <main
      className="sf-storefront sf-section"
      aria-busy="true"
      aria-label="Loading search"
    >
      <div className="sf-container sf-stack">
        <div className="h-12 w-full skeleton" />
        <div className="h-10 w-64 skeleton" />
        <div className="sf-grid">
          {Array.from({ length: 10 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    </main>
  );
}

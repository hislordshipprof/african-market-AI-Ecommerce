"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Clock3, ArrowUpRight } from "lucide-react";
const subscribe = (listener: () => void) => {
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
};
export function RecentSearches({ storeId }: { storeId: string }) {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return localStorage.getItem(`storefront-searches:${storeId}`) || "[]";
      } catch {
        return "[]";
      }
    },
    () => "[]",
  );
  let terms: string[] = [];
  try {
    const data: unknown = JSON.parse(raw);
    if (Array.isArray(data))
      terms = data
        .filter((v): v is string => typeof v === "string" && v.length < 100)
        .slice(0, 6);
  } catch {
    /* Ignore invalid history. */
  }
  return (
    <>
      {terms.length > 0 && (
        <section className="sf-search-block">
          <h3>Recently searched</h3>
          <div className="sf-search-suggestions">
            {terms.map((term) => (
              <Link
                className="sf-chip"
                href={`/search?q=${encodeURIComponent(term)}`}
                key={term}
              >
                <Clock3 size={15} aria-hidden />
                {term}
              </Link>
            ))}
          </div>
        </section>
      )}
      <section className="sf-search-block">
        <h3>Popular searches</h3>
        <div className="sf-search-suggestions">
          {["egusi", "ugu", "garri", "plantain", "ogbono", "yam"].map(
            (term) => (
              <Link className="sf-chip" href={`/search?q=${term}`} key={term}>
                {term}
                <ArrowUpRight size={15} aria-hidden />
              </Link>
            ),
          )}
        </div>
      </section>
    </>
  );
}

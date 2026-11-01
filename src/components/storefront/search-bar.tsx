"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, ArrowUpRight } from "lucide-react";
import type { SearchResult } from "@/lib/storefront/service";
import { ProductImage } from "./product-image";

export function Highlight({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  return index < 0 || !query ? (
    <>{text}</>
  ) : (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}
export function rememberSearch(storeId: string, q: string) {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(`storefront-searches:${storeId}`) || "[]",
    );
    const previous = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string")
      : [];
    localStorage.setItem(
      `storefront-searches:${storeId}`,
      JSON.stringify([q, ...previous.filter((s) => s !== q)].slice(0, 6)),
    );
  } catch {
    /* Search stays usable without browser storage. */
  }
}
export function SearchBar({ storeId }: { storeId: string }) {
  const params = useSearchParams();
  return <SearchInput key={params.get("q") || ""} storeId={storeId} />;
}
function SearchInput({ storeId }: { storeId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLFormElement>(null);
  const [query, setQuery] = useState(params.get("q") || "");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) &&
        !el.isContentEditable
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!query.trim() || !open) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(false);
      fetch(`/api/storefront/search?q=${encodeURIComponent(query)}`, {
        signal: abort.signal,
      })
        .then((r) => {
          if (!r.ok) throw new Error("Search failed");
          return r.json();
        })
        .then((data) => {
          setResults(data.results);
          setLoading(false);
        })
        .catch((e) => {
          if (e.name !== "AbortError") {
            setError(true);
            setLoading(false);
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, open]);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    rememberSearch(storeId, q);
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }
  return (
    <form
      ref={container}
      onSubmit={submit}
      role="search"
      className="sf-search-form"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor="storefront-search" className="sr-only">
        Search listings — press / to focus
      </label>
      <Search className="sf-search-icon" size={18} aria-hidden />
      <input
        ref={inputRef}
        id="storefront-search"
        name="q"
        type="search"
        autoComplete="off"
        className="sf-search-input"
        placeholder="Search egusi, plantain, your favorites…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setResults([]);
          setLoading(Boolean(e.target.value.trim()));
          setError(false);
          setOpen(true);
        }}
        aria-controls={open && query.trim() ? "instant-results" : undefined}
      />
      <kbd className="sf-search-key">/</kbd>
      {open && query.trim() && (
        <div
          id="instant-results"
          data-testid="instant-results"
          className="sf-search-dropdown"
        >
          <div role="status" aria-live="polite">
            {loading ? (
              <p>Searching the shelves…</p>
            ) : error ? (
              <p>
                Search couldn’t connect. Press Enter to try the results page.
              </p>
            ) : !results.length ? (
              <p>No matches yet. Try egusi, garri or ugu.</p>
            ) : (
              <span className="sr-only">{results.length} listings found</span>
            )}
          </div>
          {results.slice(0, 5).map((result) => (
            <Link
              key={result.id}
              href={`/listings/${result.id}`}
              onClick={() => {
                rememberSearch(storeId, query.trim());
                setOpen(false);
              }}
            >
              <ProductImage
                src={result.imageUrl}
                name={result.name}
                sizes="48px"
              />
              <span>
                <strong>
                  <Highlight text={result.name} query={query} />
                </strong>
                {result.altName && (
                  <small>
                    <Highlight text={result.altName} query={query} />
                  </small>
                )}
                <small>
                  ${(result.price / 100).toFixed(2)} · {result.packLabel}
                </small>
              </span>
            </Link>
          ))}
          {results.length > 0 && (
            <Link
              href={`/search?q=${encodeURIComponent(query.trim())}`}
              onClick={() => {
                rememberSearch(storeId, query.trim());
                setOpen(false);
              }}
            >
              See all results <ArrowUpRight size={16} />
            </Link>
          )}
        </div>
      )}
      <span className="sr-only">
        {pathname === "/search" ? "Search results page" : "Search this store"}
      </span>
    </form>
  );
}

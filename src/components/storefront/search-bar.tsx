"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, ArrowUpRight, Clock3, LayoutGrid, TrendingUp } from "lucide-react";
import type { SearchResult, SearchSuggestion } from "@/lib/storefront/service";
import { SEARCH_QUERY_TOO_LONG, normalizedSearchQuery } from "@/lib/storefront/search-query";
import { money } from "@/lib/format";
import { ProductImage } from "./product-image";
import { QuickAddStepper } from "./quick-add-stepper";
import { completionParts, latestOnly, moveActive, recentSearches, resultsMessage } from "./search-combobox";

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
interface Suggestions {
  results: SearchResult[];
  suggestions: SearchSuggestion[];
  aisles: { name: string; slug: string }[];
}
interface Row {
  id: string;
  href: string;
  /** What `rememberSearch` keeps when the shopper picks this row. */
  remember: string;
}
function SearchInput({ storeId }: { storeId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(latestOnly());
  const [query, setQuery] = useState(params.get("q") || "");
  const [data, setData] = useState<Suggestions | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [popular, setPopular] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [tooLong, setTooLong] = useState(false);
  const typed = query.trim();
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
    if (!open || typed || popular.length) return;
    const abort = new AbortController();
    fetch("/api/storefront/search", { signal: abort.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { popular?: string[] } | null) => setPopular(body?.popular ?? []))
      .catch(() => {});
    return () => abort.abort();
  }, [open, typed, popular.length]);
  useEffect(() => {
    if (!typed || !open) return;
    const abort = new AbortController();
    const token = latest.current.next();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(false);
      fetch(`/api/storefront/search?q=${encodeURIComponent(query)}`, {
        signal: abort.signal,
      })
        .then(async (r) => {
          const body = (await r.json().catch(() => null)) as (Partial<Suggestions> & { error?: string }) | null;
          if (!latest.current.isCurrent(token)) return;
          if (r.status === 400 && body?.error === SEARCH_QUERY_TOO_LONG) {
            setTooLong(true);
            setData(null);
            setLoading(false);
            return;
          }
          if (!r.ok || !body?.results) throw new Error("Search failed");
          setTooLong(false);
          setData({ results: body.results, suggestions: body.suggestions ?? [], aisles: body.aisles ?? [] });
          setActive(-1);
          setLoading(false);
        })
        .catch((e) => {
          if (e.name !== "AbortError" && latest.current.isCurrent(token)) {
            setError(true);
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, typed, open]);
  function openBox() {
    try {
      setRecent(recentSearches(localStorage.getItem(`storefront-searches:${storeId}`)));
    } catch {
      /* Search stays usable without browser storage. */
    }
    setOpen(true);
  }
  const suggestions = typed && data ? data.suggestions : [];
  const aisles = typed && data ? data.aisles : [];
  const products = typed && data ? data.results.slice(0, 5) : [];
  const recentShown = typed ? [] : recent;
  const popularShown = typed ? [] : popular.filter((term) => !recent.includes(term));
  const searchRow = (prefix: string, text: string, i: number): Row => ({
    id: `sf-search-${prefix}-${i}`,
    href: `/search?q=${encodeURIComponent(text)}`,
    remember: text,
  });
  const rows: Row[] = [
    ...recentShown.map((text, i) => searchRow("recent", text, i)),
    ...popularShown.map((text, i) => searchRow("popular", text, i)),
    ...suggestions.map((s, i) => searchRow("suggestion", s.text, i)),
    ...aisles.map((a, i) => ({ id: `sf-search-aisle-${i}`, href: `/categories/${a.slug}`, remember: typed })),
    ...products.map((p, i) => ({ id: `sf-search-product-${i}`, href: `/listings/${p.id}`, remember: typed })),
    ...(products.length ? [{ id: "sf-search-all", href: `/search?q=${encodeURIComponent(typed)}`, remember: typed }] : []),
  ];
  const rowById = new Map(rows.map((row, i) => [row.id, i]));
  const activeId = rows[active]?.id;
  const showBox = open && (typed ? true : rows.length > 0);
  function pick(row: Row) {
    if (row.remember) rememberSearch(storeId, row.remember);
    setOpen(false);
  }
  function optionProps(id: string) {
    const row = rows[rowById.get(id)!];
    return {
      id,
      role: "option",
      "aria-selected": activeId === id,
      "data-active": activeId === id ? "true" : undefined,
      tabIndex: -1,
      href: row.href,
      onClick: () => pick(row),
      onMouseMove: () => setActive(rowById.get(id)!),
    } as const;
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openBox();
      setActive(moveActive(active, rows.length, e.key));
    } else if (e.key === "Enter" && activeId) {
      e.preventDefault();
      const row = rows[active];
      pick(row);
      router.push(row.href);
    } else if (e.key === "Escape") {
      // The first Escape only closes the list; a search input would also clear the text.
      if (showBox) e.preventDefault();
      setActive(-1);
      setOpen(false);
    }
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const { query: q, tooLong: over } = normalizedSearchQuery(query);
    if (!q) return;
    if (over) {
      setTooLong(true);
      setError(false);
      setOpen(true);
      return;
    }
    rememberSearch(storeId, q);
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }
  const count = resultsMessage({ suggestions: suggestions.length, aisles: aisles.length, products: products.length });
  const group = (id: string, label: string, children: React.ReactNode) => (
    <div role="group" aria-labelledby={id} className="sf-suggest-group">
      <div id={id} role="presentation" className="sf-suggest-label">
        {label}
      </div>
      {children}
    </div>
  );
  const searchOptions = (prefix: string, terms: string[], icon: React.ReactNode) =>
    terms.map((text, i) => (
      <Link key={text} className="sf-suggest-term" {...optionProps(`sf-search-${prefix}-${i}`)}>
        {icon}
        <span>{text}</span>
      </Link>
    ));
  return (
    <form
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
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showBox}
        aria-controls="instant-results"
        aria-activedescendant={showBox ? activeId : undefined}
        autoComplete="off"
        className="sf-search-input"
        placeholder="Search egusi or plantain…"
        value={query}
        onFocus={openBox}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!e.target.value.trim()) setData(null);
          setActive(-1);
          setLoading(Boolean(e.target.value.trim()));
          setError(false);
          setTooLong(false);
          setOpen(true);
        }}
      />
      <kbd className="sf-search-key">/</kbd>
      <div role="status" aria-live="polite" className="sr-only">
        {showBox && typed && !loading && !error && !tooLong ? count || "No matches" : ""}
      </div>
      <div
        id="instant-results"
        data-testid="instant-results"
        role="listbox"
        aria-label="Search suggestions"
        className="sf-search-dropdown"
        hidden={!showBox}
      >
        {typed && (loading && !data ? (
          <p>Searching the shelves…</p>
        ) : tooLong ? (
          <p>{SEARCH_QUERY_TOO_LONG}. Use 200 characters or fewer.</p>
        ) : error ? (
          <p>Search couldn’t connect. Press Enter to try the results page.</p>
        ) : !loading && !rows.length ? (
          <p>No matches yet. Try egusi, garri or ugu.</p>
        ) : null)}
        {recentShown.length > 0 && group("sf-suggest-recent", "Recent searches", searchOptions("recent", recentShown, <Clock3 size={16} aria-hidden />))}
        {popularShown.length > 0 && group("sf-suggest-popular", "Popular in this store", searchOptions("popular", popularShown, <TrendingUp size={16} aria-hidden />))}
        {suggestions.length > 0 && group(
          "sf-suggest-searches",
          "Suggested searches",
          suggestions.map((s, i) => (
            <Link key={s.text} className="sf-suggest-term" {...optionProps(`sf-search-suggestion-${i}`)}>
              <Search size={16} aria-hidden />
              <span>
                {completionParts(s.text, typed).map((part, j) =>
                  part.bold ? <strong key={j}>{part.text}</strong> : <span key={j}>{part.text}</span>,
                )}
                {s.via && <small>also called {s.via}</small>}
              </span>
            </Link>
          )),
        )}
        {aisles.length > 0 && group(
          "sf-suggest-aisles",
          "Aisles",
          aisles.map((a, i) => (
            <Link key={a.slug} className="sf-suggest-term" {...optionProps(`sf-search-aisle-${i}`)}>
              <LayoutGrid size={16} aria-hidden />
              <span>{a.name}</span>
            </Link>
          )),
        )}
        {products.length > 0 && group(
          "sf-suggest-products",
          "Products",
          products.map((result, i) => (
            <div key={result.id} role="none" className="sf-suggest-product">
              <Link {...optionProps(`sf-search-product-${i}`)}>
                <ProductImage src={result.imageUrl} name={result.name} sizes="48px" category={result.categorySlug} />
                <span>
                  <strong>
                    <Highlight text={result.name} query={typed} />
                  </strong>
                  {result.altName && (
                    <small>
                      <Highlight text={result.altName} query={typed} />
                    </small>
                  )}
                  <small>
                    {money(result.price)} · {result.packLabel ?? "Each"}
                  </small>
                </span>
              </Link>
              <QuickAddStepper
                item={{
                  listingId: result.id,
                  variantId: result.variantId,
                  name: result.name,
                  price: result.price,
                  imageUrl: result.imageUrl,
                  categorySlug: result.categorySlug,
                  packLabel: result.packLabel,
                  maxPerOrder: result.maxPerOrder,
                }}
                blockedReason={result.badge === "ask-store" ? "Ask store first" : undefined}
              />
            </div>
          )),
        )}
        {products.length > 0 && (
          <Link className="sf-suggest-all" {...optionProps("sf-search-all")}>
            See all results <ArrowUpRight size={16} />
          </Link>
        )}
      </div>
      <span className="sr-only">
        {pathname === "/search" ? "Search results page" : "Search this store"}
      </span>
    </form>
  );
}

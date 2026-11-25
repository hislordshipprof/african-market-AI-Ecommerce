"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Package, Search, Store } from "lucide-react";
import { paletteSearchAction, type PaletteResults } from "@/lib/admin/palette-search";
import { parsePaletteQuery } from "@/lib/admin/palette-query";
import { matchNavPages } from "./admin-nav";

const SEARCH_DELAY_MS = 200;
const NONE: PaletteResults = { stores: [], orders: [] };

type Option = { id: string; href: string; label: string; detail: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> };

/**
 * The ⌘K palette (#859): pages filter as you type; stores by name or slug, and an order by store words plus its
 * number, come from the server. A modal <dialog>, so focus, the backdrop and Esc come from the browser.
 */
export function CommandPalette() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef(0);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; results: PaletteResults } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();

  // ⌘K or Ctrl+K anywhere, unless another modal (the assistant sheet) is open.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      const other = [...document.querySelectorAll("dialog[open]")].some((node) => node !== dialog.current);
      if (other) return;
      event.preventDefault();
      show();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The dialog is opened and closed directly, never from state, so a close and a quick ⌘K cannot race.
  function show() {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }

  const searchable = parsePaletteQuery(query).text !== "";
  useEffect(() => {
    if (!searchable) return;
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const results = await paletteSearchAction(query);
        if (ticket === latest.current) setFound({ query, results });
      } catch {
        if (ticket === latest.current) setFound({ query, results: NONE });
      }
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, searchable]);

  const results = searchable && found?.query === query ? found.results : NONE;
  const pending = searchable && found?.query !== query;
  const sections = useMemo(() => {
    const pages: Option[] = matchNavPages(query).map((page) => ({ id: `page-${page.href}`, href: page.href, label: page.label, detail: page.group, icon: page.icon }));
    const stores: Option[] = results.stores.map((store) => ({ id: `store-${store.id}`, href: `/admin/stores/${store.id}`, label: store.name, detail: store.slug, icon: Store }));
    const orders: Option[] = results.orders.map((order) => ({ id: `order-${order.id}`, href: `/admin/orders/search/${order.id}`, label: `Order #${order.number}`, detail: order.storeName, icon: Package }));
    return [
      { title: "Pages", options: pages },
      { title: "Stores", options: stores },
      { title: "Orders", options: orders },
    ].filter((section) => section.options.length > 0);
  }, [query, results]);
  const options = sections.flatMap((section) => section.options);
  const current = options[Math.min(active, options.length - 1)];

  function go(option: Option | undefined) {
    if (!option) return;
    dialog.current?.close();
    router.push(option.href);
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={show}
        className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 text-left text-muted-foreground hover:border-input focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:max-w-[560px]"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="truncate">Search pages, stores, orders…</span>
        <kbd className="ml-auto hidden rounded border border-border px-1.5 font-sans text-xs sm:inline">⌘ K</kbd>
      </button>
      <dialog
        ref={dialog}
        aria-label="Go to"
        onClose={() => {
          setQuery("");
          setFound(null);
          setActive(0);
        }}
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current.close();
        }}
        className="fixed inset-x-0 top-[12vh] mx-auto w-[min(640px,calc(100vw-32px))] rounded-2xl border border-border bg-card p-0 text-foreground shadow-[0_16px_48px_rgba(0,0,0,0.24)] backdrop:bg-black/40"
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <label className="sr-only" htmlFor={`${listId}-input`}>Jump to</label>
          <input
            id={`${listId}-input`}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={current?.id}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            value={query}
            placeholder="Jump to a page, or a store name and an order number…"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (options.length === 0) return;
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((index) => (Math.min(index, options.length - 1) + step + options.length) % options.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(current);
              }
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 font-sans text-xs text-muted-foreground">Esc</kbd>
        </div>
        <div id={listId} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto overscroll-contain p-2 text-sm">
          {sections.map((section) => (
            <div key={section.title} role="group" aria-labelledby={`${listId}-${section.title}`}>
              <p id={`${listId}-${section.title}`} className="px-3 pb-1 pt-2 text-[13px] font-semibold text-muted-foreground">{section.title}</p>
              {section.options.map((option) => {
                const Icon = option.icon;
                const selected = option.id === current?.id;
                return (
                  <div
                    key={option.id}
                    id={option.id}
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => setActive(options.indexOf(option))}
                    onClick={() => go(option)}
                    className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 ${selected ? "bg-muted" : ""}`}
                  >
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
                    <span className="max-w-[45%] shrink-0 truncate text-[13px] text-muted-foreground">{option.detail}</span>
                  </div>
                );
              })}
            </div>
          ))}
          <p role="status" className="px-3 py-2 text-[13px] text-muted-foreground empty:hidden">
            {pending
              ? "Searching stores and orders…"
              : options.length === 0
                ? `Nothing matches “${query.trim()}”. Try a store name, or a store name and an order number.`
                : ""}
          </p>
        </div>
      </dialog>
    </>
  );
}

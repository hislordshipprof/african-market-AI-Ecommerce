"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bath, Bean, Carrot, Check, ChevronDown, CookingPot, Cookie, CupSoda, Droplet, Fish, Flame, HeartPulse,
  LayoutGrid, Menu, Milk, Package, Salad, Search, Snowflake, Soup, Wheat, type LucideIcon,
} from "lucide-react";
import { Sheet } from "./sheet";

export interface MenuAisle {
  name: string;
  slug: string;
  count: number;
  subcategories: { name: string; slug: string; count: number }[];
}

const icons: Record<string, LucideIcon> = {
  "tubers-and-roots": Carrot, "fresh-produce": Salad, "fufu-flours-and-swallow": Wheat, "rice-grains-and-beans": Bean,
  "soup-ingredients": Soup, "spices-and-seasonings": Flame, "oils-sauces-and-condiments": Droplet, "fish-and-meat": Fish,
  frozen: Snowflake, "canned-and-packaged": Package, "breakfast-and-dairy": Milk, "snacks-and-sweets": Cookie,
  drinks: CupSoda, "health-and-wellness": HeartPulse, "beauty-and-personal-care": Bath, "household-and-kitchen": CookingPot,
};

export function AisleIcon({ slug, size = 18 }: { slug: string; size?: number }) {
  const Icon = icons[slug] ?? LayoutGrid;
  return <Icon size={size} aria-hidden className="sf-tree-icon" />;
}

const Context = createContext<{ aisles: MenuAisle[]; open: boolean; setOpen: (open: boolean) => void } | null>(null);

function useAisleMenu() {
  const value = useContext(Context);
  if (!value) throw new Error("Aisle controls require AisleMenuProvider");
  return value;
}

/** The aisle the shopper is in and the subcategory, when they are on an aisle page. */
function useHere(aisles: MenuAisle[]) {
  const slug = usePathname().match(/^\/categories\/([^/]+)/)?.[1];
  if (!slug) return null;
  const aisle = aisles.find((a) => a.slug === slug || a.subcategories.some((sub) => sub.slug === slug));
  return aisle ? { aisle, sub: aisle.slug === slug ? null : slug } : null;
}

/** One aisle tree for the whole store (#862): the header's drawer, the phone sheet and the aisle page's rail. */
export function AisleMenuProvider({ aisles, children }: { aisles: MenuAisle[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <Context.Provider value={{ aisles, open, setOpen }}>
      {children}
      <Sheet open={open} onClose={close} title="Aisles" side="start">
        <div className="sf-tree-search">
          <Search size={18} aria-hidden />
          <label className="sr-only" htmlFor="aisle-find">Find an aisle or section</label>
          <input id="aisle-find" type="search" autoComplete="off" placeholder="Find an aisle or section…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {open && <AisleTree idPrefix="menu" query={query} onNavigate={close} />}
      </Sheet>
    </Context.Provider>
  );
}

export function AisleTree({ idPrefix, query = "", onNavigate }: { idPrefix: string; query?: string; onNavigate?: () => void }) {
  const { aisles } = useAisleMenu();
  const here = useHere(aisles);
  const [expanded, setExpanded] = useState<string | null>(here?.aisle.slug ?? null);
  const needle = query.trim().toLowerCase();
  const shown = aisles.flatMap((aisle) => {
    if (!needle || aisle.name.toLowerCase().includes(needle)) return [{ aisle, subs: aisle.subcategories, matched: false }];
    const subs = aisle.subcategories.filter((sub) => sub.name.toLowerCase().includes(needle));
    return subs.length ? [{ aisle, subs, matched: true }] : [];
  });
  if (!shown.length) return <p className="sf-tree-empty">No aisle or section matches “{query.trim()}”.</p>;
  return (
    <ul className="sf-tree" data-testid={`aisle-tree-${idPrefix}`}>
      {shown.map(({ aisle, subs, matched }) => {
        const isHere = here?.aisle.slug === aisle.slug;
        const isOpen = matched || expanded === aisle.slug;
        const listId = `${idPrefix}-${aisle.slug}`;
        const allCurrent = isHere && !here.sub;
        return (
          <li key={aisle.slug}>
            <div className="sf-tree-row" data-here={isHere || undefined}>
              <Link href={`/categories/${aisle.slug}`} onClick={onNavigate} aria-current={allCurrent ? "page" : undefined}>
                <AisleIcon slug={aisle.slug} />
                <span>{aisle.name}</span>
                <span className="sf-tree-count">{aisle.count}</span>
              </Link>
              {subs.length > 0 && (
                <button
                  type="button"
                  className="sf-tree-toggle"
                  aria-expanded={isOpen}
                  aria-controls={listId}
                  aria-label={`${isOpen ? "Hide" : "Show"} ${aisle.name} sections`}
                  onClick={() => setExpanded(isOpen ? null : aisle.slug)}
                >
                  <ChevronDown size={18} aria-hidden />
                </button>
              )}
            </div>
            {isOpen && subs.length > 0 && (
              <ul className="sf-tree-subs" id={listId} aria-label={`${aisle.name} sections`}>
                {!matched && (
                  <li>
                    <Link href={`/categories/${aisle.slug}`} onClick={onNavigate} className="sf-tree-sub" aria-current={allCurrent ? "page" : undefined}>
                      {allCurrent && <Check size={16} aria-hidden />}
                      <span>All {aisle.name.toLowerCase()}</span>
                    </Link>
                  </li>
                )}
                {subs.map((sub) => {
                  const current = isHere && here.sub === sub.slug;
                  return (
                    <li key={sub.slug}>
                      <Link href={`/categories/${sub.slug}`} onClick={onNavigate} className="sf-tree-sub" data-testid="aisle-tree-sub" aria-current={current ? "page" : undefined}>
                        {current && <Check size={16} aria-hidden />}
                        <span>{sub.name}</span>
                        <span className="sf-tree-count">{sub.count}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The header's "Aisles" button (desktop). */
export function AislesButton() {
  const { open, setOpen } = useAisleMenu();
  return (
    <button type="button" className="sf-aisles-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <Menu size={20} aria-hidden />
      <span>Aisles</span>
    </button>
  );
}

/** Opens the aisle tree from anywhere: the bottom nav's tab, the home's "All N aisles" card. */
export function AislesOpener({ className, children, ...rest }: { className: string; children: ReactNode; "aria-label"?: string; "aria-current"?: "page" }) {
  const { open, setOpen } = useAisleMenu();
  return (
    <button type="button" className={className} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} {...rest}>
      {children}
    </button>
  );
}

/** The aisle page's phone picker: the aisle above the current section. */
export function AislePicker() {
  const { aisles, setOpen } = useAisleMenu();
  const here = useHere(aisles);
  if (!here) return null;
  const sub = here.aisle.subcategories.find((s) => s.slug === here.sub);
  return (
    <button type="button" className="sf-aisle-pick" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span>
        <small>{here.aisle.name}</small>
        <b>{sub ? sub.name : `All ${here.aisle.name.toLowerCase()}`}</b>
      </span>
      <ChevronDown size={20} aria-hidden />
    </button>
  );
}

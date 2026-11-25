"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Box, Search, ShoppingBag, User } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { orderStatusLabel } from "@/lib/order/status-labels";
import type { AdminSearchResults } from "@/lib/store-admin/search";
import { adminSearchAction } from "./actions";

const EMPTY: AdminSearchResults = { orders: [], products: [], customers: [] };
const DELAY_MS = 200;

/** ⌘K search across orders, products and customers (#860). Each result opens the page that shows it. */
export function SearchDialog({ open, onOpenChange, storeSlug }: { open: boolean; onOpenChange: (open: boolean) => void; storeSlug: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminSearchResults>(EMPTY);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const seq = useRef(0);
  const store = `store=${encodeURIComponent(storeSlug)}`;

  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!q) {
      setResults(EMPTY);
      setState("idle");
      return;
    }
    setState("loading");
    const timer = setTimeout(() => {
      adminSearchAction(q)
        .then((found) => {
          if (seq.current !== mine) return;
          setResults(found);
          setState("idle");
        })
        .catch(() => seq.current === mine && setState("failed"));
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  function close() {
    onOpenChange(false);
  }

  const q = query.trim();
  const none = q && state === "idle" && results.orders.length + results.products.length + results.customers.length === 0;
  const link = "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] translate-y-0 gap-0 p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Order number, customer or product"
            aria-label="Search orders, products and customers"
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2" aria-live="polite">
          {!q && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Type an order number, a customer&apos;s name or phone, or a product.</p>}
          {state === "failed" && <p className="px-3 py-6 text-center text-sm text-destructive">Search didn&apos;t go through. Try again.</p>}
          {none && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches &ldquo;{q}&rdquo;.</p>}
          {results.orders.length > 0 && (
            <ResultGroup title="Orders">
              {results.orders.map((order) => (
                <li key={order.id}>
                  <Link
                    href={order.active ? `/store-admin/orders/${order.id}?${store}` : `/store-admin/orders/past/${order.id}?${store}`}
                    onClick={close}
                    className={link}
                  >
                    <ShoppingBag className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-semibold tabular-nums">#{order.number}</span>
                    <span className="min-w-0 flex-1 truncate">{order.customerName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{orderStatusLabel(order.status, order.fulfillment)}</span>
                  </Link>
                </li>
              ))}
            </ResultGroup>
          )}
          {results.products.length > 0 && (
            <ResultGroup title="Products">
              {results.products.map((product) => (
                <li key={product.id}>
                  <Link href={`/store-admin/listings?${store}`} onClick={close} className={link}>
                    <Box className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{product.name}</span>
                  </Link>
                </li>
              ))}
            </ResultGroup>
          )}
          {results.customers.length > 0 && (
            <ResultGroup title="Customers">
              {results.customers.map((customer) => (
                <li key={customer.id}>
                  <Link href={`/store-admin/orders/past?${store}&q=${encodeURIComponent(customer.name)}`} onClick={close} className={link}>
                    <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{customer.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">Past orders</span>
                  </Link>
                </li>
              ))}
            </ResultGroup>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-2">
      <h2 className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">{title}</h2>
      <ul>{children}</ul>
    </section>
  );
}

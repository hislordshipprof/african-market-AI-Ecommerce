"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, ImageOff, Search } from "lucide-react";
import { listMasterCatalog, type CatalogRow } from "@/lib/admin/master-catalog";
import { approveProductProposal, rejectProductProposal, type ProductProposalRow } from "@/lib/admin/product-proposals";

type Mode = "create" | "link" | "reject";

const MODES: Array<{ key: Mode; label: string }> = [
  { key: "create", label: "Add as new" },
  { key: "link", label: "Same as a catalog product" },
  { key: "reject", label: "Reject" },
];

const FIELD = "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground";
const LABEL = "grid gap-1 text-xs font-medium text-muted-foreground";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Store owners' suggestions for new master products: add as new, link to an existing product, or reject. */
export function ProductProposals({
  proposals,
  categories,
}: {
  proposals: ProductProposalRow[];
  categories: Array<{ id: string; name: string }>;
}) {
  if (proposals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No store suggestions waiting. They arrive when an owner publishes an item from a shelf photo that the catalog does not have.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} categories={categories} />
      ))}
    </div>
  );
}

function ProposalCard({ proposal, categories }: { proposal: ProductProposalRow; categories: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("create");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState({
    name: proposal.name,
    localName: proposal.localName ?? "",
    size: proposal.size ?? "",
    categoryId: proposal.categoryId ?? "",
    usePhoto: proposal.hasPhoto,
  });
  const [query, setQuery] = useState(proposal.name);
  const [results, setResults] = useState<CatalogRow[] | null>(null);
  const [linkId, setLinkId] = useState("");
  const [reason, setReason] = useState("");
  const id = (field: string) => `${field}-${proposal.id}`;

  function run(action: () => Promise<{ success?: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const page = await listMasterCatalog({ q: query.trim(), status: "active", pageSize: 8 });
      setResults(page.products);
      setLinkId(page.products[0]?.id ?? "");
    });
  }

  return (
    <article aria-labelledby={id("title")} className="rounded-xl border border-border bg-card p-4">
      <div className="flex gap-4">
        <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
          {proposal.hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/admin/product-proposals/${proposal.id}/photo`} alt={`Photo the store framed for ${proposal.name}`} className="size-full object-contain" />
          ) : (
            <ImageOff aria-label="No photo suggested" className="size-6 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id={id("title")} className="text-base font-semibold text-foreground">
            {proposal.name}
            {proposal.localName && <span className="font-normal text-muted-foreground"> · {proposal.localName}</span>}
          </h3>
          <p className="text-sm text-muted-foreground">
            {[proposal.size, proposal.categoryName ?? "No category suggested"].filter(Boolean).join(" · ")}
          </p>
          <p className="text-sm text-muted-foreground">
            {proposal.storeName} sells it as “{proposal.listingName ?? proposal.name}” at {dollars(proposal.listingPriceCents)}
            {" · "}
            <time dateTime={new Date(proposal.createdAt).toISOString()}>{new Date(proposal.createdAt).toLocaleDateString()}</time>
          </p>
        </div>
      </div>

      <div role="radiogroup" aria-label={`Decision for ${proposal.name}`} className="mt-4 flex flex-wrap gap-1 rounded-xl bg-muted p-1">
        {MODES.map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={mode === option.key}
            onClick={() => {
              setMode(option.key);
              setError(null);
            }}
            className={`min-h-10 flex-1 rounded-lg px-3 text-sm font-medium transition-colors ${
              mode === option.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      {mode === "create" && (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => approveProductProposal({
              proposalId: proposal.id,
              mode: "create",
              name: fields.name,
              localName: fields.localName || null,
              size: fields.size || null,
              categoryId: fields.categoryId || null,
              usePhoto: proposal.hasPhoto && fields.usePhoto,
            }));
          }}
        >
          <label htmlFor={id("name")} className={LABEL}>
            Name
            <input id={id("name")} className={FIELD} value={fields.name} maxLength={200} required onChange={(event) => setFields({ ...fields, name: event.target.value })} />
          </label>
          <label htmlFor={id("local")} className={LABEL}>
            Local name (added as a synonym)
            <input id={id("local")} className={FIELD} value={fields.localName} maxLength={100} onChange={(event) => setFields({ ...fields, localName: event.target.value })} />
          </label>
          <label htmlFor={id("size")} className={LABEL}>
            Size or pack
            <input id={id("size")} className={FIELD} value={fields.size} maxLength={40} onChange={(event) => setFields({ ...fields, size: event.target.value })} />
          </label>
          <label htmlFor={id("category")} className={LABEL}>
            Category
            <select id={id("category")} className={FIELD} value={fields.categoryId} onChange={(event) => setFields({ ...fields, categoryId: event.target.value })}>
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
            {proposal.hasPhoto ? (
              <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                <input type="checkbox" className="size-4 accent-primary" checked={fields.usePhoto} onChange={(event) => setFields({ ...fields, usePhoto: event.target.checked })} />
                Use the store’s photo
              </label>
            ) : <span />}
            <button type="submit" disabled={isPending} className="min-h-10 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              Approve and add to catalog
            </button>
          </div>
        </form>
      )}

      {mode === "link" && (
        <div className="mt-3 space-y-3">
          <form role="search" onSubmit={search} className="flex gap-2">
            <label htmlFor={id("search")} className="sr-only">Search active catalog products</label>
            <input id={id("search")} className={FIELD} value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" disabled={isPending || !query.trim()} className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50">
              <Search aria-hidden="true" className="size-4" /> Search
            </button>
          </form>
          {results && results.length === 0 && <p className="text-sm text-muted-foreground">No active product matches. Try another name, or add it as new.</p>}
          {results && results.length > 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(() => approveProductProposal({ proposalId: proposal.id, mode: "link", masterProductId: linkId }));
              }}
              className="space-y-3"
            >
              <fieldset className="divide-y divide-border rounded-lg border border-border">
                <legend className="sr-only">Catalog product it is the same as</legend>
                {results.map((row) => (
                  <label key={row.id} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm text-foreground">
                    <input type="radio" name={id("link")} className="size-4 accent-primary" value={row.id} checked={linkId === row.id} onChange={() => setLinkId(row.id)} />
                    <span className="flex-1">{row.name}</span>
                    <span className="text-xs text-muted-foreground">{[row.unit, row.categoryName].filter(Boolean).join(" · ")}</span>
                  </label>
                ))}
              </fieldset>
              <div className="flex justify-end">
                <button type="submit" disabled={isPending || !linkId} className="min-h-10 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  Approve and link the store’s listing
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {mode === "reject" && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => rejectProductProposal({ proposalId: proposal.id, reason }));
          }}
        >
          <label htmlFor={id("reason")} className={LABEL}>
            Reason the store sees (optional)
            <textarea id={id("reason")} rows={2} maxLength={500} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">The store’s listing keeps selling as it is.</p>
            <button type="submit" disabled={isPending} className="min-h-10 rounded-full border border-destructive/40 px-4 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
              Reject suggestion
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

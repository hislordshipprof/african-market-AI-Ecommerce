"use client";

import { useActionState, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ImageOff } from "lucide-react";
import {
  dismissDuplicatePair,
  mergeDuplicatePair,
  type DuplicateActionState,
  type DuplicatePairView,
  type PairProduct,
} from "@/lib/admin/catalog-duplicates";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const OUTLINE_BUTTON = `inline-flex min-h-11 items-center rounded-full border border-input px-5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 ${FOCUS}`;

const VERDICT_LABELS = { same: "Claude: same product", different: "Claude: different products", unsure: "Claude: unsure" } as const;
const STATUS_LABELS: Record<string, string> = { unknown: "not known", known: "from a store owner", reviewed: "reviewed" };

function AttributeLine({ label, status, values }: { label: string; status: string; values: string[] }) {
  const shown = status === "unknown" ? "" : values.length === 0 ? "none" : values.map((value) => value.replaceAll("_", " ")).join(", ");
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words text-foreground">
        {shown ? `${shown} ` : ""}
        <span className="text-muted-foreground">({STATUS_LABELS[status] ?? status})</span>
      </dd>
    </div>
  );
}

function ProductColumn({ product, pairId, survivorId, onPick }: {
  product: PairProduct;
  pairId: string;
  survivorId: string;
  onPick: (id: string) => void;
}) {
  const total = product.stores.reduce((sum, store) => sum + store.listings, 0);
  return (
    <div className="grid min-w-0 content-start gap-3 rounded-lg border border-border p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.imageUrl} alt={`${product.name} photo`} className="size-full object-cover" loading="lazy" />
          ) : (
            <ImageOff role="img" aria-label="No photo" className="size-6 text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0">
          <Link href={`/admin/catalog/products/${product.id}`} className={`break-words font-medium text-foreground underline-offset-4 hover:underline ${FOCUS}`}>
            {product.name}
          </Link>
          <p className="text-sm text-muted-foreground">
            {[product.categoryName, product.subcategory, product.unit, product.weightG ? `${product.weightG} g` : null, product.status.replace("_", " ")]
              .filter(Boolean)
              .join(", ")}
          </p>
        </div>
      </div>

      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Synonyms</dt>
          <dd className="break-words text-foreground">{product.synonyms.length > 0 ? product.synonyms.join(", ") : "None"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Listings</dt>
          <dd className="text-foreground">
            {total === 0 ? "No store lists it" : (
              <ul>
                {product.stores.map((store) => (
                  <li key={store.storeId}>{store.storeName}: {store.listings}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <AttributeLine label="Ingredients" status={product.ingredients.status} values={product.ingredients.names} />
        <AttributeLine label="Allergens" status={product.allergens.status} values={product.allergens.values} />
        <AttributeLine label="Dietary claims" status={product.dietary.status} values={product.dietary.values} />
      </dl>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-input px-3 text-sm font-medium text-foreground has-[:checked]:border-primary has-[:checked]:bg-accent">
        <input
          type="radio"
          name={`keep-${pairId}`}
          value={product.id}
          checked={survivorId === product.id}
          onChange={() => onPick(product.id)}
          className="size-5 accent-primary"
        />
        Keep this one
      </label>
    </div>
  );
}

export function PairCard({ pair }: { pair: DuplicatePairView }) {
  const router = useRouter();
  const headingId = useId();
  const [survivorId, setSurvivorId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [mergeState, merge, merging] = useActionState<DuplicateActionState, FormData>(mergeDuplicatePair, {});
  const [dismissState, dismiss, dismissing] = useActionState<DuplicateActionState, FormData>(dismissDuplicatePair, {});
  const state = merging || dismissing ? {} : mergeState.message ? mergeState : dismissState;

  useEffect(() => {
    if (mergeState.ok || dismissState.ok) router.refresh();
  }, [mergeState, dismissState, router]);

  const survivor = survivorId === pair.a.id ? pair.a : survivorId === pair.b.id ? pair.b : null;
  const loser = survivor ? (survivor.id === pair.a.id ? pair.b : pair.a) : null;

  return (
    <article aria-labelledby={headingId} className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 id={headingId} className="sr-only">{pair.a.name} and {pair.b.name}</h2>
      <p className="text-sm">
        <span className="font-medium text-foreground">{pair.verdict ? VERDICT_LABELS[pair.verdict] : "Not judged yet"}</span>
        {pair.verdictReason ? <span className="text-muted-foreground"> — {pair.verdictReason}</span> : null}
      </p>
      <p className="text-sm text-muted-foreground">
        Names {Math.round(pair.nameSimilarity * 100)}% alike
        {pair.sharedTerms > 0 ? `, ${pair.sharedTerms} shared ${pair.sharedTerms === 1 ? "name or synonym" : "names or synonyms"}` : ""}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ProductColumn product={pair.a} pairId={pair.id} survivorId={survivorId} onPick={(id) => { setSurvivorId(id); setConfirming(false); }} />
        <ProductColumn product={pair.b} pairId={pair.id} survivorId={survivorId} onPick={(id) => { setSurvivorId(id); setConfirming(false); }} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {confirming && survivor && loser ? (
          <form action={merge} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="pairId" value={pair.id} />
            <input type="hidden" name="survivorId" value={survivor.id} />
            <p className="w-full text-sm text-foreground">
              Merge {loser.name} into {survivor.name}? Its listings move to {survivor.name}. This cannot be undone.
            </p>
            <button
              type="submit"
              disabled={merging}
              className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`}
            >
              {merging ? "Merging…" : "Confirm merge"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={merging} className={OUTLINE_BUTTON}>Cancel</button>
          </form>
        ) : (
          <>
            <button
              type="button"
              disabled={!survivor}
              onClick={() => setConfirming(true)}
              className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`}
            >
              Merge
            </button>
            <form action={dismiss}>
              <input type="hidden" name="pairId" value={pair.id} />
              <button type="submit" disabled={dismissing} className={OUTLINE_BUTTON}>
                {dismissing ? "Saving…" : "Not a duplicate"}
              </button>
            </form>
            {!survivor && <p className="text-sm text-muted-foreground">Pick the product to keep to merge.</p>}
          </>
        )}
        <p role="status" className={`w-full text-sm ${state.ok === false ? "text-destructive" : "text-muted-foreground"}`}>
          {state.message ?? ""}
        </p>
      </div>
    </article>
  );
}

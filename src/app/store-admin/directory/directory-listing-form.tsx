"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  CUISINE_TAGS,
  CUISINE_TAGS_MAX,
  LISTING_BLURB_MAX,
  blurbLength,
  normalizeBlurb,
  type CuisineTag,
} from "@/lib/directory/listing-fields";
import { updateDirectoryListing } from "@/lib/store-admin/directory-actions";

interface Listing {
  listed: boolean;
  blurb: string;
  cuisineTags: CuisineTag[];
}

interface Props {
  storeName: string;
  storeSlug: string;
  place: string;
  located: boolean;
  /** The store's status: only an active store is in the directory (#449, #555). */
  status: string;
  initial: Listing;
  /** Other store settings, shown below the listing form with their own save. */
  children?: React.ReactNode;
}

export function DirectoryListingForm({ storeName, storeSlug, place, located, status, initial, children }: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [listing, setListing] = useState<Listing>(initial);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const length = blurbLength(normalizeBlurb(listing.blurb) ?? "");
  const tooLong = length > LISTING_BLURB_MAX;
  const tagsFull = listing.cuisineTags.length >= CUISINE_TAGS_MAX;

  function change(next: Partial<Listing>) {
    setListing((current) => ({ ...current, ...next }));
    setNotice(null);
  }

  function toggleTag(tag: CuisineTag) {
    const on = listing.cuisineTags.includes(tag);
    if (!on && tagsFull) return;
    change({ cuisineTags: on ? listing.cuisineTags.filter((t) => t !== tag) : [...listing.cuisineTags, tag] });
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (tooLong) return;
    startTransition(async () => {
      const result = await updateDirectoryListing(listing);
      setNotice(result.ok ? { ok: true, text: "Saved. The directory shows it now." } : { ok: false, text: result.message });
    });
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link href={`/store-admin?store=${storeParam}`} aria-label="Back to store admin">
            <Button variant="ghost" size="icon" className="size-9" tabIndex={-1}>
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">Directory listing</h1>
            <p className="text-xs text-muted-foreground">{storeName}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        <form onSubmit={save} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Show your store in the Store directory</CardTitle>
              <CardDescription>
                The directory helps shoppers find independent stores by state, city and distance. They order from
                your own storefront, never a shared cart.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex min-h-11 items-center justify-between gap-4">
                <label htmlFor="listed" className="text-sm font-medium text-foreground">
                  Listed in the directory
                </label>
                <Switch
                  id="listed"
                  checked={listing.listed}
                  onCheckedChange={(checked) => change({ listed: checked })}
                  aria-describedby="listed-state"
                />
              </div>
              <p id="listed-state" className="text-sm text-muted-foreground">
                {listing.listed
                  ? `Shoppers see ${storeName}${place ? ` in ${place}` : ""}. The directory never shows your street address.`
                  : "Off. Shoppers can still reach your storefront by its link."}
              </p>
              {listing.listed && (!located || status !== "active") ? (
                <p role="note" className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {status === "setup"
                    ? "Your store appears once it goes live."
                    : status !== "active"
                      ? "Your store is paused, so it stays out of the directory until it is active again."
                      : "Your store appears once the platform team confirms its address. Ask them if it is missing."}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <label htmlFor="blurb">Short description</label>
              </CardTitle>
              <CardDescription id="blurb-hint">
                One or two lines on your directory card: what you sell and what you are known for.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Textarea
                id="blurb"
                value={listing.blurb}
                onChange={(event) => change({ blurb: event.target.value })}
                rows={3}
                aria-describedby="blurb-hint blurb-count"
                aria-invalid={tooLong || undefined}
                placeholder="Nigerian and West African groceries since 2009: fresh yam, egusi, palm oil and stockfish."
                className="text-base md:text-base"
              />
              <p
                id="blurb-count"
                className={`flex items-center gap-1.5 text-sm ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
              >
                {tooLong ? <CircleAlert className="size-4" aria-hidden="true" /> : null}
                {tooLong
                  ? `${length - LISTING_BLURB_MAX} characters over the ${LISTING_BLURB_MAX} limit`
                  : `${length} of ${LISTING_BLURB_MAX} characters`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base" id="cuisines-title">
                Cuisines
              </CardTitle>
              <CardDescription id="cuisines-hint">
                Pick up to {CUISINE_TAGS_MAX}. Shoppers use them to find the food they grew up with.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul role="list" aria-labelledby="cuisines-title" aria-describedby="cuisines-hint" className="flex flex-wrap gap-2">
                {CUISINE_TAGS.map((tag) => {
                  const on = listing.cuisineTags.includes(tag.value);
                  const blocked = !on && tagsFull;
                  return (
                    <li key={tag.value}>
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={blocked}
                        onClick={() => toggleTag(tag.value)}
                        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                          on
                            ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary"
                            : "border-border bg-card text-foreground hover:bg-muted"
                        }`}
                      >
                        {on ? <Check className="size-4" aria-hidden="true" /> : null}
                        {tag.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
                {listing.cuisineTags.length} of {CUISINE_TAGS_MAX} picked
              </p>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || tooLong} className="min-h-11 rounded-full px-6">
              {pending ? "Saving..." : "Save listing"}
            </Button>
            {notice ? (
              <p
                role={notice.ok ? "status" : "alert"}
                className={`flex items-center gap-1.5 text-sm ${notice.ok ? "text-muted-foreground" : "text-destructive"}`}
              >
                {notice.ok ? <Check className="size-4" aria-hidden="true" /> : <CircleAlert className="size-4" aria-hidden="true" />}
                {notice.text}
              </p>
            ) : null}
          </div>
        </form>
        {children ? <div className="mt-6 flex flex-col gap-6">{children}</div> : null}
      </main>
    </div>
  );
}

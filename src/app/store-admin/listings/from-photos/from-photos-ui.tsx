"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { toast } from "sonner";
import { ArrowLeft, Camera, CheckCircle2, ImageOff, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { jpegBlob } from "@/lib/image/client-jpeg";
import { PHOTO_UPLOAD_MAX_BYTES } from "@/lib/listing/csv-file-cap";
import { dismissListingDrafts, publishListingDrafts, uploadShelfPhoto } from "@/lib/listing/photo-draft-actions";
import type { DraftCard, PublishRefusal } from "@/lib/listing/photo-drafts";

const BATCH_MAX = 10;
const PRICE_RE = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/;

function priceToCents(raw: string): number | null {
  const match = PRICE_RE.exec(raw.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 && cents <= 1_000_000 ? cents : null;
}

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

const REFUSAL_TEXT: Record<PublishRefusal, string> = {
  price_not_confirmed: "check the price first",
  price_invalid: "enter a price between $0.01 and $10,000",
  pick_needed: "pick the product first",
  already_listed: "already listed",
  not_found: "already published or dismissed",
};

interface RowState {
  price: string;
  /** The owner typed the price or ticked "Price checked". */
  confirmed: boolean;
  selected: boolean;
  /** A `several` pick: a master product id, "new" for a new item, or "" for none yet. */
  pick: string;
}

function initialRow(draft: DraftCard): RowState {
  return {
    price: draft.priceReadCents ? centsToInput(draft.priceReadCents) : "",
    confirmed: false,
    selected: draft.match !== "already_listed",
    pick: "",
  };
}

interface Props {
  storeName: string;
  storeSlug: string;
  isOwner: boolean;
  readOnly: boolean;
  drafts: DraftCard[];
}

export function FromPhotosUi({ storeName, storeSlug, isOwner, readOnly, drafts }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [isPending, startTransition] = useTransition();

  const toReview = drafts.filter((draft) => draft.match !== "already_listed");
  const listed = drafts.filter((draft) => draft.match === "already_listed");
  const rowOf = (draft: DraftCard) => rows[draft.id] ?? initialRow(draft);
  const setRow = (draft: DraftCard, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [draft.id]: { ...(prev[draft.id] ?? initialRow(draft)), ...patch } }));

  function pickFiles(list: FileList | null) {
    const picked = [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
    if (picked.length > BATCH_MAX) toast.error(`Add up to ${BATCH_MAX} photos at a time. The first ${BATCH_MAX} are kept.`);
    setFiles(picked.slice(0, BATCH_MAX));
  }

  function readPhotos() {
    startTransition(async () => {
      let created = 0;
      let failed = 0;
      for (const [index, file] of files.entries()) {
        setProgress(`Reading photo ${index + 1} of ${files.length}`);
        try {
          const form = new FormData();
          form.set("photo", await jpegBlob(file, PHOTO_UPLOAD_MAX_BYTES), "shelf.jpg");
          const result = await uploadShelfPhoto(form);
          if (!result.ok) {
            failed += 1;
            toast.error(`${file.name}: ${result.message}`);
            if (result.code === "rate_limited" || result.code === "copilot_resting") break;
            continue;
          }
          created += result.created;
          if (result.overflow) toast.message(`${file.name}: only the first 30 items were read. Take a closer photo of the rest.`);
          if (result.created === 0) toast.message(`${file.name}: no products could be read. Try a sharper, closer photo.`);
        } catch (error) {
          if (isRedirectError(error)) throw error;
          failed += 1;
          toast.error(`${file.name}: the photo could not be sent. Try again.`);
        }
      }
      setProgress(null);
      setFiles([]);
      if (fileRef.current) fileRef.current.value = "";
      if (created > 0) toast.success(`${created} ${created === 1 ? "item" : "items"} read. Check them below.`);
      else if (failed === 0) toast.message("No new items were read.");
      router.refresh();
    });
  }

  function publish() {
    const selected = toReview.filter((draft) => rowOf(draft).selected);
    if (selected.length === 0) {
      toast.error("Select at least one item to publish.");
      return;
    }
    const picks = selected.map((draft) => {
      const row = rowOf(draft);
      return {
        draftId: draft.id,
        priceCents: priceToCents(row.price) ?? 0,
        priceConfirmed: row.confirmed,
        ...(draft.match === "several" && row.pick ? { masterProductId: row.pick === "new" ? null : row.pick } : {}),
      };
    });
    startTransition(async () => {
      let response: Awaited<ReturnType<typeof publishListingDrafts>>;
      try {
        response = await publishListingDrafts({ picks });
      } catch (error) {
        if (isRedirectError(error)) throw error;
        toast.error("We couldn't publish. Press Publish again. Nothing is listed twice.");
        return;
      }
      if (!response.ok) {
        toast.error(response.message);
        return;
      }
      const { listingIds, refused } = response.result;
      if (listingIds.length > 0) toast.success(`Published ${listingIds.length} ${listingIds.length === 1 ? "listing" : "listings"}.`);
      const names = new Map(drafts.map((draft) => [draft.id, draft.extractedName]));
      for (const refusal of refused) toast.error(`${names.get(refusal.draftId) ?? "An item"}: ${REFUSAL_TEXT[refusal.reason]}.`);
      router.refresh();
    });
  }

  function dismiss(ids: string[]) {
    if (ids.length === 0) return;
    startTransition(async () => {
      const response = await dismissListingDrafts({ draftIds: ids });
      if (!response.ok) toast.error(response.message);
      router.refresh();
    });
  }

  const selectedCount = toReview.filter((draft) => rowOf(draft).selected).length;

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-ink)]">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <Link
            href={`/store-admin/listings?store=${storeSlug}`}
            className="inline-flex min-h-11 items-center gap-1 text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Products
          </Link>
        </div>

        <h1 className="mb-1 font-[family-name:var(--font-display)] text-2xl font-bold">Add listings from shelf photos</h1>
        <p className="mb-6 text-sm text-[var(--color-muted)]">
          Photograph your shelves. We read each product and match it to the catalog for {storeName}. Nothing is listed until
          the owner sets a price and publishes.
        </p>

        {!readOnly && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Camera className="h-5 w-5" aria-hidden />
                Shelf photos
              </CardTitle>
              <CardDescription>Up to {BATCH_MAX} photos at a time. Shelf photos stay private and are never shown to shoppers.</CardDescription>
            </CardHeader>
            <CardContent>
              <label
                htmlFor="shelf-photos"
                className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[var(--color-line)] bg-[var(--color-bg)] p-6 text-center focus-within:border-[var(--color-primary)]"
              >
                <Camera className="h-7 w-7 text-[var(--color-muted)]" aria-hidden />
                <span className="text-sm font-medium">
                  {files.length > 0 ? `${files.length} ${files.length === 1 ? "photo" : "photos"} ready` : "Take or choose shelf photos"}
                </span>
                <input
                  id="shelf-photos"
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="sr-only"
                  onChange={(event) => pickFiles(event.target.files)}
                  disabled={isPending}
                />
              </label>
              {files.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2" aria-label="Photos to read">
                  {files.map((file, index) => (
                    <li key={`${file.name}-${index}`} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs">
                      {file.name}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex items-center justify-end gap-3">
                {progress && <span className="text-sm text-[var(--color-muted)]" role="status">{progress}</span>}
                <Button onClick={readPhotos} disabled={files.length === 0 || isPending}>
                  {progress ? "Reading..." : "Read photos"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <section aria-labelledby="to-review">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="to-review" className="text-lg font-semibold">
              To review <span className="font-normal text-[var(--color-muted)]">({toReview.length})</span>
            </h2>
            {isOwner && toReview.length > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isPending || selectedCount === 0}
                  onClick={() => dismiss(toReview.filter((draft) => rowOf(draft).selected).map((draft) => draft.id))}
                >
                  Dismiss selected
                </Button>
                <Button size="sm" disabled={isPending || selectedCount === 0} onClick={publish}>
                  Publish {selectedCount > 0 ? selectedCount : ""}
                </Button>
              </div>
            )}
          </div>
          {!isOwner && toReview.length > 0 && (
            <p className="mb-3 flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <Info className="h-4 w-4 shrink-0" aria-hidden /> The owner sets prices and publishes these.
            </p>
          )}
          {toReview.length === 0 ? (
            <p className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-muted)]">
              No items waiting. Read a shelf photo to start.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
              {toReview.map((draft) => (
                <DraftRow key={draft.id} draft={draft} row={rowOf(draft)} isOwner={isOwner} disabled={isPending} onChange={(patch) => setRow(draft, patch)} />
              ))}
            </ul>
          )}
        </section>

        {listed.length > 0 && (
          <section aria-labelledby="already-listed" className="mt-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="already-listed" className="text-lg font-semibold">
                Already listed <span className="font-normal text-[var(--color-muted)]">({listed.length})</span>
              </h2>
              {isOwner && (
                <Button variant="outline" size="sm" disabled={isPending} onClick={() => dismiss(listed.map((draft) => draft.id))}>
                  Clear these
                </Button>
              )}
            </div>
            <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
              {listed.map((draft) => (
                <li key={draft.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
                  <span className="flex-1">
                    {draft.extractedName}
                    {draft.extractedSize && <span className="text-[var(--color-muted)]"> · {draft.extractedSize}</span>}
                  </span>
                  <Badge variant="secondary">Already listed</Badge>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  row,
  isOwner,
  disabled,
  onChange,
}: {
  draft: DraftCard;
  row: RowState;
  isOwner: boolean;
  disabled: boolean;
  onChange: (patch: Partial<RowState>) => void;
}) {
  const priceId = `price-${draft.id}`;
  const readFromPhoto = draft.priceReadCents !== null;
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {isOwner && (
          <input
            type="checkbox"
            className="mt-1 size-5 shrink-0 accent-[var(--color-primary)]"
            checked={row.selected}
            onChange={(event) => onChange({ selected: event.target.checked })}
            aria-label={`Select ${draft.extractedName}`}
            disabled={disabled}
          />
        )}
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--color-photo-well,var(--color-raised))]">
          {draft.masterImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={draft.masterImageUrl} alt="" className="size-full object-contain" />
          ) : (
            <ImageOff className="h-5 w-5 text-[var(--color-muted)]" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {draft.extractedName}
            {draft.extractedSize && <span className="font-normal text-[var(--color-muted)]"> · {draft.extractedSize}</span>}
          </p>
          {draft.match === "one" && (
            <p className="text-sm text-[var(--color-muted)]">Catalog match: {draft.masterProductName}</p>
          )}
          {draft.match === "none" && <p className="text-sm text-[var(--color-muted)]">Not in the catalog. Lists as a new item.</p>}
          {draft.match === "several" && (
            isOwner ? (
              <label className="mt-1 block text-sm">
                <span className="text-[var(--color-muted)]">Which product is it?</span>
                <select
                  className="mt-1 block h-11 w-full max-w-xs rounded-lg border border-[var(--color-line-strong,var(--color-line))] bg-[var(--color-surface)] px-3 text-sm"
                  value={row.pick}
                  onChange={(event) => onChange({ pick: event.target.value })}
                  disabled={disabled}
                >
                  <option value="">Pick one</option>
                  {draft.candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                  ))}
                  <option value="new">None of these: a new item</option>
                </select>
              </label>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">{draft.candidates.length} possible catalog matches</p>
            )
          )}
        </div>
      </div>
      {isOwner && (
        <div className="flex flex-col gap-1 sm:w-48 sm:items-end">
          <label htmlFor={priceId} className="text-xs font-semibold text-[var(--color-muted)]">Price</label>
          <div className="flex items-center gap-1">
            <span aria-hidden className="text-sm text-[var(--color-muted)]">$</span>
            <Input
              id={priceId}
              inputMode="decimal"
              className="h-11 w-28"
              value={row.price}
              placeholder="0.00"
              onChange={(event) => onChange({ price: event.target.value, confirmed: event.target.value.trim() !== "" })}
              disabled={disabled}
              aria-describedby={readFromPhoto ? `${priceId}-note` : undefined}
            />
          </div>
          {readFromPhoto && (
            <div id={`${priceId}-note`} className="flex flex-col gap-1 sm:items-end">
              <span className="text-xs text-[var(--color-muted)]">Read from photo, check it</span>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--color-primary)]"
                  checked={row.confirmed}
                  onChange={(event) => onChange({ confirmed: event.target.checked })}
                  disabled={disabled}
                />
                Price checked
              </label>
            </div>
          )}
        </div>
      )}
      {!isOwner && draft.priceReadCents !== null && (
        <p className="text-sm text-[var(--color-muted)]">Tag: ${centsToInput(draft.priceReadCents)}</p>
      )}
    </li>
  );
}

"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CheckCircle2, Clock, Crop, ImagePlus, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { StoreProposalRow } from "@/lib/catalog/product-proposals";

export interface FrameCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The framed area's width over its height, in photo pixels, for the preview. */
  aspect: number;
}

export interface SuggestionState {
  name: string;
  localName: string;
  size: string;
  categoryId: string;
  crop: FrameCrop | null;
}

const FIELD = "h-11 w-full rounded-lg border border-[var(--color-line-strong,var(--color-line))] bg-[var(--color-surface)] px-3 text-sm font-normal text-[var(--color-ink)]";
/** Inputs sit on the raised panel: surface ground, regular ink, so a filled field never reads as disabled. */
const INPUT = "h-11 bg-[var(--color-surface)] text-sm font-normal text-[var(--color-ink)]";

/** The fields an owner fills to suggest an unmatched item for the shared catalog. */
export function SuggestionFields({
  draftId,
  itemName,
  value,
  categories,
  disabled,
  onChange,
}: {
  draftId: string;
  itemName: string;
  value: SuggestionState;
  categories: Array<{ id: string; name: string }>;
  disabled: boolean;
  onChange: (patch: Partial<SuggestionState>) => void;
}) {
  const [framing, setFraming] = useState(false);
  const id = (field: string) => `suggest-${field}-${draftId}`;
  return (
    <fieldset className="mt-3 grid gap-3 rounded-xl bg-[var(--color-raised)] p-3 sm:grid-cols-2" disabled={disabled}>
      <legend className="sr-only">Catalog suggestion for {itemName}</legend>
      <label htmlFor={id("name")} className="grid gap-1 text-xs font-semibold text-[var(--color-muted)]">
        Product name
        <Input id={id("name")} className={INPUT} value={value.name} maxLength={200} required onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      <label htmlFor={id("local")} className="grid gap-1 text-xs font-semibold text-[var(--color-muted)]">
        Local name <span className="font-normal">(optional)</span>
        <Input id={id("local")} className={INPUT} value={value.localName} maxLength={100} placeholder="e.g. ogiri igbo" onChange={(event) => onChange({ localName: event.target.value })} />
      </label>
      <label htmlFor={id("size")} className="grid gap-1 text-xs font-semibold text-[var(--color-muted)]">
        Size or pack
        <Input id={id("size")} className={INPUT} value={value.size} maxLength={40} placeholder="e.g. 500g" onChange={(event) => onChange({ size: event.target.value })} />
      </label>
      <label htmlFor={id("category")} className="grid gap-1 text-xs font-semibold text-[var(--color-muted)]">
        Category
        <select id={id("category")} className={FIELD} value={value.categoryId} onChange={(event) => onChange({ categoryId: event.target.value })}>
          <option value="">Not sure</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        {value.crop ? (
          <>
            <FramePreview draftId={draftId} crop={value.crop} />
            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setFraming(true)}>
              <Crop className="size-4" aria-hidden /> Change photo
            </Button>
            <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => onChange({ crop: null })}>
              Remove photo
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setFraming(true)}>
            <ImagePlus className="size-4" aria-hidden /> Add a photo from the shelf
          </Button>
        )}
        <span className="text-xs text-[var(--color-muted)]">Optional. Used only if the platform team approves it.</span>
      </div>
      {framing && (
        <FrameDialog
          draftId={draftId}
          itemName={itemName}
          initial={value.crop}
          onClose={() => setFraming(false)}
          onConfirm={(crop) => {
            onChange({ crop });
            setFraming(false);
          }}
        />
      )}
    </fieldset>
  );
}

/** The framed part of the shelf photo, drawn from the private photo with CSS. */
function FramePreview({ draftId, crop }: { draftId: string; crop: FrameCrop }) {
  const span = (part: number) => (part >= 0.999 ? 0 : 1 - part);
  return (
    <div
      role="img"
      aria-label="Framed product photo"
      className="h-14 shrink-0 rounded-xl bg-[var(--color-photo-well,var(--color-raised))] bg-no-repeat"
      style={{
        aspectRatio: Math.min(2, Math.max(0.5, crop.aspect)),
        backgroundImage: `url(/api/listing-photo/${draftId})`,
        backgroundSize: `${100 / crop.width}% ${100 / crop.height}%`,
        backgroundPosition: `${span(crop.width) ? (crop.x / span(crop.width)) * 100 : 0}% ${span(crop.height) ? (crop.y / span(crop.height)) * 100 : 0}%`,
      }}
    />
  );
}

const MIN = 0.05;
const STEP = 0.02;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The owner drags a box over the shelf photo around one product. Arrow keys move the box and
 * Shift with an arrow key resizes it, so the frame works without a pointer too.
 */
function FrameDialog({
  draftId,
  itemName,
  initial,
  onClose,
  onConfirm,
}: {
  draftId: string;
  itemName: string;
  initial: FrameCrop | null;
  onClose: () => void;
  onConfirm: (crop: FrameCrop) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState(() => initial ?? { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  const [loaded, setLoaded] = useState<"loading" | "ready" | "failed">("loading");

  function pointAt(event: PointerEvent<HTMLDivElement>) {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = pointAt(event);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const point = pointAt(event);
    const x = Math.min(start.current.x, point.x);
    const y = Math.min(start.current.y, point.y);
    setBox({ x, y, width: Math.abs(point.x - start.current.x), height: Math.abs(point.y - start.current.y) });
  }

  function onPointerUp() {
    start.current = null;
    setBox((current) => ({
      x: clamp(current.x, 0, 1 - MIN),
      y: clamp(current.y, 0, 1 - MIN),
      width: clamp(current.width, MIN, 1 - clamp(current.x, 0, 1 - MIN)),
      height: clamp(current.height, MIN, 1 - clamp(current.y, 0, 1 - MIN)),
    }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setBox((current) => {
      if (event.shiftKey) {
        const width = clamp(current.width + move[0], MIN, 1 - current.x);
        const height = clamp(current.height + move[1], MIN, 1 - current.y);
        return { ...current, width, height };
      }
      return { ...current, x: clamp(current.x + move[0], 0, 1 - current.width), y: clamp(current.y + move[1], 0, 1 - current.height) };
    });
  }

  function confirm() {
    const img = imgRef.current;
    const aspect = img && img.naturalHeight > 0 ? (box.width * img.naturalWidth) / (box.height * img.naturalHeight) : 1;
    onConfirm({ ...box, aspect });
  }

  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Frame {itemName}</DialogTitle>
          <DialogDescription>
            Drag a box around the product on your shelf photo. Arrow keys move the box; Shift and an arrow key resize it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center rounded-xl bg-[var(--color-photo-well,var(--color-raised))]">
          <div
            ref={wrapRef}
            className="relative touch-none select-none overflow-hidden"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={`/api/listing-photo/${draftId}`}
              alt={`Shelf photo with ${itemName}`}
              draggable={false}
              className="block max-h-[55vh] w-auto max-w-full"
              onLoad={() => setLoaded("ready")}
              onError={() => setLoaded("failed")}
            />
            {loaded === "ready" && (
              <div
                tabIndex={0}
                role="group"
                aria-label={`Photo frame at ${Math.round(box.x * 100)}% across, ${Math.round(box.y * 100)}% down, ${Math.round(box.width * 100)}% wide, ${Math.round(box.height * 100)}% tall`}
                onKeyDown={onKeyDown}
                className="absolute rounded-md border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] outline-none focus-visible:ring-4 focus-visible:ring-[var(--color-primary)]"
                style={{ left: pct(box.x), top: pct(box.y), width: pct(box.width), height: pct(box.height) }}
              />
            )}
          </div>
        </div>
        {loaded === "failed" && (
          <p role="alert" className="text-sm text-[var(--color-muted)]">The shelf photo could not be loaded. You can suggest the item without a photo.</p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11" onClick={onClose}>Cancel</Button>
          <Button type="button" className="min-h-11" disabled={loaded !== "ready"} onClick={confirm}>Use this photo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STATUS: Record<StoreProposalRow["status"], { icon: typeof Clock; label: (row: StoreProposalRow) => string }> = {
  pending: { icon: Clock, label: () => "Waiting for the platform team" },
  approved: { icon: CheckCircle2, label: (row) => (row.masterProductName ? `In the catalog as ${row.masterProductName}` : "In the catalog") },
  rejected: { icon: XCircle, label: (row) => (row.rejectReason ? `Not added: ${row.rejectReason}` : "Not added. Your listing stays as it is.") },
};

/** This store's catalog suggestions and how each ended. */
export function SuggestionList({ proposals }: { proposals: StoreProposalRow[] }) {
  if (proposals.length === 0) return null;
  return (
    <section aria-labelledby="suggested" className="mt-8">
      <h2 id="suggested" className="mb-1 text-lg font-semibold">
        Suggested for the catalog <span className="font-normal text-[var(--color-muted)]">({proposals.length})</span>
      </h2>
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        Your listing sells now under its own name. Once the platform team adds it to the shared catalog, it picks up the catalog name, category and photo.
      </p>
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
        {proposals.map((row) => {
          const status = STATUS[row.status];
          const Icon = status.icon;
          return (
            <li key={row.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-start sm:gap-3">
              <span className="font-medium sm:flex-1">{row.name}</span>
              <span className="flex items-start gap-2 text-[var(--color-muted)] sm:max-w-[60%]">
                <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                {status.label(row)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
